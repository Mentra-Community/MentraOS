import {Hono} from 'hono';
import {TestRunGithubApp} from '../../services/test-run-github-app';
import {createTestHostAuth, type TestHostEnv} from '../middleware/test-host-auth.middleware';

/** Enrolled controllers refresh org runner authority; no App key leaves Core. */
export function createTestingDispatchApi(appCredentials: Pick<TestRunGithubApp, 'runnerCredential'> = new TestRunGithubApp(),
  credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>();
  app.use('*', async (c, next) => {c.header('Cache-Control', 'no-store'); await next();});
  app.use('*', createTestHostAuth(credentials));
  app.onError((_error, c) => c.json({error: 'runner_credential_unavailable'}, 503));
  app.post('/runner-token', async c => c.json(await appCredentials.runnerCredential()));
  return app;
}
