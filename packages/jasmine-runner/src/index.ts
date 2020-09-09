import { declareFactoryPlugin, PluginKind } from '@stryker-mutator/api/plugin';

import * as strykerValidationSchema from '../schema/jasmine-runner-options.json';

import { JasmineTestRunner, createJasmineTestRunner } from './JasmineTestRunner';

export const strykerPlugins = [declareFactoryPlugin(PluginKind.TestRunner2, 'jasmine', createJasmineTestRunner)];

export { strykerValidationSchema, JasmineTestRunner, createJasmineTestRunner };
