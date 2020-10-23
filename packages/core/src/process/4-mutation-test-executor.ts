import { from, zip, partition, merge, Observable } from 'rxjs';
import { flatMap, toArray, map, tap, shareReplay } from 'rxjs/operators';
import * as shuffle from 'shuffle-array';
import { tokens, commonTokens } from '@stryker-mutator/api/plugin';
import { StrykerOptions } from '@stryker-mutator/api/core';
import { MutantResult, MutantStatus } from '@stryker-mutator/api/report';
import { MutantRunOptions, MutantRunStatus, TestRunner } from '@stryker-mutator/api/test-runner';
import { Logger } from '@stryker-mutator/api/logging';
import { I } from '@stryker-mutator/util';
import { CheckStatus, Checker, CheckResult, PassedCheckResult } from '@stryker-mutator/api/check';

import { coreTokens } from '../di';
import StrictReporter from '../reporters/strict-reporter';
import { MutantTestCoverage } from '../mutants/find-mutant-test-coverage';
import { MutationTestReportHelper } from '../reporters/mutation-test-report-helper';
import Timer from '../utils/timer';
import { Pool, ConcurrencyTokenProvider } from '../concurrent';
import { Sandbox } from '../sandbox';

import { DryRunContext } from './3-dry-run-executor';

export interface MutationTestContext extends DryRunContext {
  [coreTokens.testRunnerPool]: I<Pool<TestRunner>>;
  [coreTokens.timeOverheadMS]: number;
  [coreTokens.mutationTestReportHelper]: MutationTestReportHelper;
  [coreTokens.mutantsWithTestCoverage]: MutantTestCoverage[];
}

export class MutationTestExecutor {
  public static inject = tokens(
    commonTokens.options,
    coreTokens.reporter,
    coreTokens.checkerPool,
    coreTokens.testRunnerPool,
    coreTokens.timeOverheadMS,
    coreTokens.mutantsWithTestCoverage,
    coreTokens.mutationTestReportHelper,
    coreTokens.sandbox,
    commonTokens.logger,
    coreTokens.timer,
    coreTokens.concurrencyTokenProvider
  );

  constructor(
    private readonly options: StrykerOptions,
    private readonly reporter: StrictReporter,
    private readonly checkerPool: I<Pool<Checker>>,
    private readonly testRunnerPool: I<Pool<TestRunner>>,
    private readonly timeOverheadMS: number,
    private readonly matchedMutants: readonly MutantTestCoverage[],
    private readonly mutationTestReportHelper: I<MutationTestReportHelper>,
    private readonly sandbox: I<Sandbox>,
    private readonly log: Logger,
    private readonly timer: I<Timer>,
    private readonly concurrencyTokenProvider: I<ConcurrencyTokenProvider>,
    private sampledMutants: number = 0,
    private samplingThreshold: number = 0,
    private estNrOfValidMutants: number = 0,
  ) {}

  public async execute(): Promise<MutantResult[]> {
    const { ignoredResult$, notIgnoredMutant$ } = this.executeIgnore(from(this.matchedMutants));
    const { passedMutant$, checkResult$ } = this.executeCheck(from(notIgnoredMutant$));
    const shuffledMutant$ = this.executeShuffle(from(passedMutant$));
    const { coveredMutant$, noCoverageResult$ } = this.executeNoCoverage(shuffledMutant$);
    const { testRunnerResult$, notSampledMutant$ } = this.executeRunInTestRunner(coveredMutant$);
    const allIgnoredResult$ = merge(ignoredResult$, notSampledMutant$);
    const results = await merge(testRunnerResult$, checkResult$, noCoverageResult$, allIgnoredResult$).pipe(toArray()).toPromise();
    this.mutationTestReportHelper.reportAll(results);
    await this.reporter.wrapUp();
    this.logDone();
    return results;
  }

  private executeIgnore(input$: Observable<MutantTestCoverage>) {
    const [notIgnoredMutant$, ignoredMutant$] = partition(input$.pipe(shareReplay()), ({ mutant }) => mutant.ignoreReason === undefined);
    const ignoredResult$ = ignoredMutant$.pipe(map(({ mutant }) => this.mutationTestReportHelper.reportMutantIgnored(mutant)));
    return { ignoredResult$, notIgnoredMutant$ };
  }

  private executeNoCoverage(input$: Observable<MutantTestCoverage>) {
    const [coveredMutant$, noCoverageMatchedMutant$] = partition(input$.pipe(shareReplay()), (matchedMutant) => matchedMutant.coveredByTests);
    const noCoverageResult$ = noCoverageMatchedMutant$.pipe(map(({ mutant }) => this.mutationTestReportHelper.reportNoCoverage(mutant)));
    return { noCoverageResult$, coveredMutant$ };
  }

  private executeCheck(input$: Observable<MutantTestCoverage>) {
    const checkTask$ = zip(input$, this.checkerPool.worker$).pipe(
      flatMap(async ([matchedMutant, checker]) => {
        const checkResult = await checker.check(matchedMutant.mutant);
        this.checkerPool.recycle(checker);
        return {
          checkResult,
          matchedMutant,
        };
      }),
      // Dispose when all checks are completed.
      // This will allow resources to be freed up and more test runners to be spined up.
      tap({
        complete: () => {
          this.checkerPool.dispose();
          this.concurrencyTokenProvider.freeCheckers();
        },
      })
    );
    const [passedCheckResult$, failedCheckResult$] = partition(
      checkTask$.pipe(shareReplay()),
      ({ checkResult }) => checkResult.status === CheckStatus.Passed
    );
    const checkResult$ = failedCheckResult$.pipe(
      map((failedMutant) =>
        this.mutationTestReportHelper.reportCheckFailed(
          failedMutant.matchedMutant.mutant,
          failedMutant.checkResult as Exclude<CheckResult, PassedCheckResult>
        )
      )
    );
    const passedMutant$ = passedCheckResult$.pipe(map(({ matchedMutant }) => matchedMutant));
    return { checkResult$, passedMutant$ };
  }

  private executeShuffle(input$: Observable<MutantTestCoverage>) {
    if (this.options.sampling) {
      return input$.pipe(
        shareReplay(),
        toArray(),
        map(arr => {
          this.estNrOfValidMutants = arr.length;
          this.updateSamplingThreshold()
          this.log.info(`Sampling Mutants. Estimated number of sampled mutants: ${this.samplingThreshold}`)
          return shuffle(arr);
        }),
        flatMap(x => x)
      )
    } else {
      return input$;
    }
  }

  private executeRunInTestRunner(input$: Observable<MutantTestCoverage>) {
    const runResult$ = zip(this.testRunnerPool.worker$, input$).pipe(
      flatMap(async ([testRunner, matchedMutant]) => {
        if (this.sampledMutants < this.samplingThreshold || !this.options.sampling) {
          const mutantRunOptions = this.createMutantRunOptions(matchedMutant);
          const result = await testRunner.mutantRun(mutantRunOptions);
          this.testRunnerPool.recycle(testRunner);

          if (
            !(result.status === MutantRunStatus.Timeout) &&
            !(result.status === MutantRunStatus.Error)
          ) {
            this.sampledMutants++;
          } else {
            this.estNrOfValidMutants--;
            this.updateSamplingThreshold();
          }
          
          return this.mutationTestReportHelper.reportMutantRunResult(matchedMutant, result);
        } else {
          this.testRunnerPool.recycle(testRunner);
          matchedMutant.mutant.ignoreReason = "Not sampled";
          return this.mutationTestReportHelper.reportMutantIgnored(matchedMutant.mutant);
        }
      })
    );
    
    const [testRunnerResult$, notSampledMutant$] = partition(runResult$.pipe(shareReplay()), mutantResult => mutantResult.status === MutantStatus.Ignored);
    return { testRunnerResult$, notSampledMutant$ };
  }

  private updateSamplingThreshold() {
    this.samplingThreshold = Math.ceil(this.options.samplingRate / 100 * this.estNrOfValidMutants)
  }

  private createMutantRunOptions(mutant: MutantTestCoverage): MutantRunOptions {
    const timeout = this.options.timeoutFactor * mutant.estimatedNetTime + this.options.timeoutMS + this.timeOverheadMS;
    return {
      activeMutant: mutant.mutant,
      timeout: timeout,
      testFilter: mutant.testFilter,
      sandboxFileName: this.sandbox.sandboxFileFor(mutant.mutant.fileName),
    };
  }

  private logDone() {
    this.log.info('Done in %s.', this.timer.humanReadableElapsed());
  }
}
