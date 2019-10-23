import { allowedTestNameCharacters } from './allowed_characters.js';
import { Fixture } from './fixture.js';
import { TestCaseID } from './id.js';
import { LiveTestCaseResult, TestCaseRecorder, TestSpecRecorder } from './logger.js';
import { ParamSpec, ParamSpecIterable, paramsEquals } from './params/index.js';
import { checkPublicParamType, extractPublicParams } from './url_query.js';

export interface RunCase {
  readonly id: TestCaseID;
  run(debug?: boolean): Promise<LiveTestCaseResult>;
}

export interface RunCaseIterable {
  iterate(rec: TestSpecRecorder): Iterable<RunCase>;
}

type FixtureClass<F extends Fixture> = new (log: TestCaseRecorder, params: ParamSpec) => F;
type TestFn<F extends Fixture> = (t: F) => Promise<void> | void;

const validNames = new RegExp('^[' + allowedTestNameCharacters + ']+$');

export class TestGroup<F extends Fixture> implements RunCaseIterable {
  private fixture: FixtureClass<F>;
  private seen: Set<string> = new Set();
  private tests: Array<Test<F>> = [];

  constructor(fixture: FixtureClass<F>) {
    this.fixture = fixture;
  }

  *iterate(log: TestSpecRecorder): Iterable<RunCase> {
    for (const test of this.tests) {
      yield* test.iterate(log);
    }
  }

  private checkName(name: string): void {
    if (!validNames.test(name)) {
      throw new Error(`Invalid test name ${name}; must match [${validNames}]+`);
    }
    if (name !== decodeURIComponent(name)) {
      // Shouldn't happen due to the rule above. Just makes sure that treated
      // unencoded strings as encoded strings is OK.
      throw new Error(`Not decodeURIComponent-idempotent: ${name} !== ${decodeURIComponent(name)}`);
    }

    if (this.seen.has(name)) {
      throw new Error(`Duplicate test name: ${name}`);
    }
    this.seen.add(name);
  }

  // TODO: This could take a fixture, too, to override the one for the group.
  test(name: string, fn: TestFn<F>): Test<F> {
    this.checkName(name);

    const test = new Test<F>(name, this.fixture, fn);
    this.tests.push(test);
    return test;
  }
}

// This test is created when it's inserted, but may be parameterized afterward (.params()).
class Test<F extends Fixture> {
  readonly name: string;
  readonly fixture: FixtureClass<F>;
  readonly fn: TestFn<F>;
  private cases: ParamSpecIterable | null = null;

  constructor(name: string, fixture: FixtureClass<F>, fn: TestFn<F>) {
    this.name = name;
    this.fixture = fixture;
    this.fn = fn;
  }

  params(specs: ParamSpecIterable): void {
    if (this.cases !== null) {
      throw new Error('test case is already parameterized');
    }
    const cases = Array.from(specs);
    const seen: ParamSpec[] = [];
    // This is n^2.
    for (const spec of cases) {
      const publicParams = extractPublicParams(spec);

      // Check type of public params: can only be (currently):
      // number, string, boolean, undefined, number[]
      for (const v of Object.values(publicParams)) {
        checkPublicParamType(v);
      }

      if (seen.some(x => paramsEquals(x, publicParams))) {
        throw new Error('Duplicate test case params');
      }
      seen.push(publicParams);
    }
    this.cases = cases;
  }

  *iterate(rec: TestSpecRecorder): IterableIterator<RunCase> {
    for (const params of this.cases || [null]) {
      yield new RunCaseSpecific(rec, this.name, params, this.fixture, this.fn);
    }
  }
}

class RunCaseSpecific<F extends Fixture> implements RunCase {
  readonly id: TestCaseID;
  private readonly params: ParamSpec | null;
  private readonly recorder: TestSpecRecorder;
  private readonly fixture: FixtureClass<F>;
  private readonly fn: TestFn<F>;

  constructor(
    recorder: TestSpecRecorder,
    test: string,
    params: ParamSpec | null,
    fixture: FixtureClass<F>,
    fn: TestFn<F>
  ) {
    this.id = { test, params: params ? extractPublicParams(params) : null };
    this.params = params;
    this.recorder = recorder;
    this.fixture = fixture;
    this.fn = fn;
  }

  async run(debug: boolean): Promise<LiveTestCaseResult> {
    const [rec, res] = this.recorder.record(this.id.test, this.id.params);
    rec.start(debug);

    try {
      const inst = new this.fixture(rec, this.params || {});
      await inst.init();
      try {
        await this.fn(inst);
      } catch (ex) {
        // There was an exception from the test itself.
        rec.threw(ex);
      }
      // Runs as long as constructor and init succeeded, even if the test rejected.
      await inst.finalize();
    } catch (ex) {
      // There was an exception from constructor, init, or finalize.
      rec.threw(ex);
    }

    rec.finish();
    return res;
  }
}
