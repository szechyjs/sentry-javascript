const http = require('http');
const express = require('express');
const app = express();
const Sentry = require('../../../dist');

function assertSessions(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error('FAILED: Sessions do not match');
    process.exit(1);
  }
}

function constructStrippedSessionObject(actual) {
  const { init, status, errors, release } = actual;
  return { init, status, errors, release };
}

let remaining = 2;

class DummyTransport {
  sendSession(session) {
    if (session.did === 'ahmed') {
      assertSessions(constructStrippedSessionObject(session),
        {
          init: true,
          status: "ok",
          errors: 0,
          release: "1.1"
        }
      )
    }
    else if (session.did === 'ahmed2') {
      assertSessions(constructStrippedSessionObject(session),
        {
          init: true,
          status: "ok",
          errors: 1,
          release: "1.1"
        }
      )
    }
    --remaining;

    if (!remaining) {
      console.error('SUCCESS: All application mode sessions were sent to node transport as expected');
      server.close();
      process.exit(0);
    }

    return Promise.resolve({
      status: 'success',
    });
  }
}

Sentry.init({
  dsn: 'http://test@example.com/1337',
  release: '1.1',
  transport: DummyTransport,
});


app.use(Sentry.Handlers.requestHandler());

app.get('/foo', (req) => {
  const currentHub = Sentry.getCurrentHub();
  currentHub.startSession({user: {username: 'ahmed'}});
  currentHub.captureSession();
});

app.get('/bar', req => {
  const currentHub = Sentry.getCurrentHub();
  currentHub.startSession({user: {username: 'ahmed2'}});
  throw new Error('bar');
  currentHub.captureSession();
});

app.use(Sentry.Handlers.errorHandler());

const server = app.listen(0, () => {
  const port = server.address().port;
  http.get(`http://localhost:${port}/foo`);
  http.get(`http://localhost:${port}/bar`);
});

