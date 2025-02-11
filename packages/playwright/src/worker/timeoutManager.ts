/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { colors } from 'playwright-core/lib/utilsBundle';
import { TimeoutRunner, TimeoutRunnerError } from 'playwright-core/lib/utils';
import type { Location } from '../../types/testReporter';

export type TimeSlot = {
  timeout: number;
  elapsed: number;
};

type RunnableType = 'test' | 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach' | 'slow' | 'skip' | 'fail' | 'fixme' | 'teardown';

export type RunnableDescription = {
  type: RunnableType;
  location?: Location;
  slot?: TimeSlot;  // Falls back to test slot.
  fixture?: FixtureDescription;
};

export type FixtureDescription = {
  title: string;
  phase: 'setup' | 'teardown';
  location?: Location;
  slot?: TimeSlot;  // Falls back to the runnable slot.
};

export class TimeoutManager {
  private _defaultSlot: TimeSlot;
  private _runnable: RunnableDescription;
  private _timeoutRunner: TimeoutRunner;

  constructor(timeout: number) {
    this._defaultSlot = { timeout, elapsed: 0 };
    this._runnable = { type: 'test' };
    this._timeoutRunner = new TimeoutRunner(timeout);
  }

  interrupt() {
    this._timeoutRunner.interrupt();
  }

  async withRunnable<T>(runnable: RunnableDescription | undefined, cb: () => Promise<T>): Promise<T> {
    if (!runnable)
      return await cb();
    this._updateRunnable(runnable);
    try {
      return await this._timeoutRunner.run(cb);
    } catch (error) {
      if (!(error instanceof TimeoutRunnerError))
        throw error;
      throw this._createTimeoutError();
    } finally {
      this._updateRunnable({ type: 'test' });
    }
  }

  defaultSlotTimings() {
    const slot = this._currentSlot();
    slot.elapsed = this._timeoutRunner.elapsed();
    return this._defaultSlot;
  }

  slow() {
    const slot = this._currentSlot();
    slot.timeout = slot.timeout * 3;
    this._timeoutRunner.updateTimeout(slot.timeout);
  }

  setTimeout(timeout: number) {
    const slot = this._currentSlot();
    if (!slot.timeout)
      return; // Zero timeout means some debug mode - do not set a timeout.
    slot.timeout = timeout;
    this._timeoutRunner.updateTimeout(timeout);
  }

  currentRunnableType() {
    return this._runnable?.type || 'test';
  }

  currentSlotDeadline() {
    return this._timeoutRunner.deadline();
  }

  private _currentSlot() {
    return this._runnable.fixture?.slot || this._runnable.slot || this._defaultSlot;
  }

  private _updateRunnable(runnable: RunnableDescription) {
    let slot = this._currentSlot();
    slot.elapsed = this._timeoutRunner.elapsed();

    this._runnable = runnable;

    slot = this._currentSlot();
    this._timeoutRunner.updateTimeout(slot.timeout, slot.elapsed);
  }

  private _createTimeoutError(): Error {
    let message = '';
    const timeout = this._currentSlot().timeout;
    switch (this._runnable.type || 'test') {
      case 'test': {
        if (this._runnable.fixture) {
          if (this._runnable.fixture.phase === 'setup') {
            message = `Test timeout of ${timeout}ms exceeded while setting up "${this._runnable.fixture.title}".`;
          } else {
            message = [
              `Test finished within timeout of ${timeout}ms, but tearing down "${this._runnable.fixture.title}" ran out of time.`,
              `Please allow more time for the test, since teardown is attributed towards the test timeout budget.`,
            ].join('\n');
          }
        } else {
          message = `Test timeout of ${timeout}ms exceeded.`;
        }
        break;
      }
      case 'afterEach':
      case 'beforeEach':
        message = `Test timeout of ${timeout}ms exceeded while running "${this._runnable.type}" hook.`;
        break;
      case 'beforeAll':
      case 'afterAll':
        message = `"${this._runnable.type}" hook timeout of ${timeout}ms exceeded.`;
        break;
      case 'teardown': {
        if (this._runnable.fixture)
          message = `Worker teardown timeout of ${timeout}ms exceeded while ${this._runnable.fixture.phase === 'setup' ? 'setting up' : 'tearing down'} "${this._runnable.fixture.title}".`;
        else
          message = `Worker teardown timeout of ${timeout}ms exceeded.`;
        break;
      }
      case 'skip':
      case 'slow':
      case 'fixme':
      case 'fail':
        message = `"${this._runnable.type}" modifier timeout of ${timeout}ms exceeded.`;
        break;
    }
    const fixtureWithSlot = this._runnable.fixture?.slot ? this._runnable.fixture : undefined;
    if (fixtureWithSlot)
      message = `Fixture "${fixtureWithSlot.title}" timeout of ${timeout}ms exceeded during ${fixtureWithSlot.phase}.`;
    message = colors.red(message);
    const location = (fixtureWithSlot || this._runnable).location;
    const error = new TimeoutManagerError(message);
    error.name = '';
    // Include location for hooks, modifiers and fixtures to distinguish between them.
    error.stack = message + (location ? `\n    at ${location.file}:${location.line}:${location.column}` : '');
    return error;
  }
}

export class TimeoutManagerError extends Error {}
