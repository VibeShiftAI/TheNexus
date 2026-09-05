const { EventEmitter } = require('events');

describe('upstream SSE recovery', () => {
  let connect, requests;
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    requests = [];
    connect = jest.fn((_path, _opts, callback) => {
      const req = new EventEmitter();
      req.destroy = jest.fn();
      requests.push({ req, callback });
      return req;
    });
    jest.doMock('../services/praxis-client', () => ({ praxisStream: connect }));
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
  function respond(code) {
    const res = new EventEmitter();
    res.statusCode = code;
    res.resume = jest.fn();
    res.destroy = jest.fn();
    res.setEncoding = jest.fn();
    requests.at(-1).callback(res);
    return res;
  }
  test('503 clears the failed request and reconnects', () => {
    require('../routes/praxis-stream')();
    respond(503);
    jest.advanceTimersByTime(1000);
    expect(connect).toHaveBeenCalledTimes(2);
  });
  test('aborted stream reconnects once and stale callbacks cannot clear the replacement', () => {
    require('../routes/praxis-stream')();
    const old = respond(200);
    old.emit('aborted');
    old.emit('error', new Error('aborted'));
    jest.advanceTimersByTime(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    respond(200);
    old.emit('end');
    jest.advanceTimersByTime(30000);
    expect(connect).toHaveBeenCalledTimes(2);
  });
  test('late response from a failed request is discarded after replacement', () => {
    require('../routes/praxis-stream')();
    const old = requests[0];
    old.req.emit('error', new Error('socket lost'));
    jest.advanceTimersByTime(1000);
    respond(200);
    const late = new EventEmitter();
    late.statusCode = 200;
    late.setEncoding = jest.fn();
    late.destroy = jest.fn();
    old.callback(late);
    expect(late.destroy).toHaveBeenCalledTimes(1);
  });
  test('explicit teardown cancels pending retries', () => {
    const router = require('../routes/praxis-stream')();
    respond(503);
    router.closeUpstream();
    jest.advanceTimersByTime(30000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

});
