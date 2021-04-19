import {
  AggregationCounts,
  RequestSessionStatus,
  Session as SessionInterface,
  SessionAggregate,
  SessionContext,
  SessionFlusher as SessionFlusherInterface,
  SessionStatus,
  Transport,
} from '@sentry/types';
import { dropUndefinedKeys, logger, uuid4 } from '@sentry/utils';

import { getCurrentHub } from './hub';

/**
 * @inheritdoc
 */
export class Session implements SessionInterface {
  public userAgent?: string;
  public errors: number = 0;
  public release?: string;
  public sid: string = uuid4();
  public did?: string;
  public timestamp: number = Date.now();
  public started: number = Date.now();
  public duration: number = 0;
  public status: SessionStatus = SessionStatus.Ok;
  public environment?: string;
  public ipAddress?: string;
  public init: boolean = true;

  constructor(context?: Omit<SessionContext, 'started' | 'status'>) {
    if (context) {
      this.update(context);
    }
  }

  /** JSDoc */
  // eslint-disable-next-line complexity
  update(context: SessionContext = {}): void {
    if (context.user) {
      if (context.user.ip_address) {
        this.ipAddress = context.user.ip_address;
      }

      if (!context.did) {
        this.did = context.user.id || context.user.email || context.user.username;
      }
    }

    this.timestamp = context.timestamp || Date.now();

    if (context.sid) {
      // Good enough uuid validation. — Kamil
      this.sid = context.sid.length === 32 ? context.sid : uuid4();
    }
    if (context.init !== undefined) {
      this.init = context.init;
    }
    if (context.did) {
      this.did = `${context.did}`;
    }
    if (typeof context.started === 'number') {
      this.started = context.started;
    }
    if (typeof context.duration === 'number') {
      this.duration = context.duration;
    } else {
      this.duration = this.timestamp - this.started;
    }
    if (context.release) {
      this.release = context.release;
    }
    if (context.environment) {
      this.environment = context.environment;
    }
    if (context.ipAddress) {
      this.ipAddress = context.ipAddress;
    }
    if (context.userAgent) {
      this.userAgent = context.userAgent;
    }
    if (typeof context.errors === 'number') {
      this.errors = context.errors;
    }
    if (context.status) {
      this.status = context.status;
    }
  }

  /** JSDoc */
  close(status?: Exclude<SessionStatus, SessionStatus.Ok>): void {
    if (status) {
      this.update({ status });
    } else if (this.status === SessionStatus.Ok) {
      this.update({ status: SessionStatus.Exited });
    } else {
      this.update();
    }
  }

  /** JSDoc */
  toJSON(): {
    init: boolean;
    sid: string;
    did?: string;
    timestamp: string;
    started: string;
    duration: number;
    status: SessionStatus;
    errors: number;
    attrs?: {
      release?: string;
      environment?: string;
      user_agent?: string;
      ip_address?: string;
    };
  } {
    return dropUndefinedKeys({
      sid: `${this.sid}`,
      init: this.init,
      started: new Date(this.started).toISOString(),
      timestamp: new Date(this.timestamp).toISOString(),
      status: this.status,
      errors: this.errors,
      did: typeof this.did === 'number' || typeof this.did === 'string' ? `${this.did}` : undefined,
      duration: this.duration,
      attrs: dropUndefinedKeys({
        release: this.release,
        environment: this.environment,
        ip_address: this.ipAddress,
        user_agent: this.userAgent,
      }),
    });
  }
}

type releaseHealthAttributes = {
  environment?: string;
  release: string;
};

/**
 * @inheritdoc
 */
export class SessionFlusher implements SessionFlusherInterface {
  public readonly flushTimeout: number = 60;
  private _pendingAggregates: { [key: number]: AggregationCounts } = {};
  private _sessionAttrs: releaseHealthAttributes;
  private _intervalId: ReturnType<typeof setInterval>;
  private _isEnabled: boolean = true;
  private _transport: Transport;

  constructor(transport: Transport, attrs: releaseHealthAttributes) {
    this._transport = transport;
    // Call to setInterval, so that flush is called every 60 seconds
    this._intervalId = setInterval(() => this.flush(), this.flushTimeout * 1000);
    this._sessionAttrs = attrs;
  }

  /** Checks if the instance of SessionFlusher is enabled */
  public getEnabled(): boolean {
    return this._isEnabled;
  }

  /** Sends session aggregate to Transport */
  public sendSessionAggregate(sessionAggregate: SessionAggregate): void {
    if (!this._transport.sendSessionAggregate) {
      logger.warn("Dropping session because custom transport doesn't implement sendSessionAggregate");
      return;
    }
    this._transport.sendSessionAggregate(sessionAggregate).then(null, reason => {
      logger.error(`Error while sending session: ${reason}`);
    });
  }

  /** Checks if `pendingAggregates` has entries, and if it does flushes them by calling `sendSessions` */
  flush(): void {
    const sessionAggregate = this.getSessionAggregate();
    if (sessionAggregate.aggregates.length === 0) {
      return;
    }
    this._pendingAggregates = {};
    this.sendSessionAggregate(sessionAggregate);
  }

  /** Massages the entries in `pendingAggregates` and returns aggregated sessions */
  getSessionAggregate(): SessionAggregate {
    const aggregates: AggregationCounts[] = Object.keys(this._pendingAggregates).map((key: string) => {
      return this._pendingAggregates[parseInt(key)];
    });

    const sessionAggregate: SessionAggregate = {
      attrs: this._sessionAttrs,
      aggregates: aggregates,
    };
    return dropUndefinedKeys(sessionAggregate);
  }

  /** JSDoc */
  close(): void {
    clearTimeout(this._intervalId);
    this._isEnabled = false;
    this.flush();
  }

  /**
   * Wrapper function for _incrementSessionCount that checks if the instance of SessionFlusher is enabled then fetches
   * the session status of the request from `_requestSessionStatus` on the scope and passes them to `_incrementSessionCount`
   * along with the start date
   */
  public incrementSessionCount(): void {
    if (!this._isEnabled) {
      return;
    }
    const scope = getCurrentHub().getScope();
    /* eslint-disable @typescript-eslint/no-unsafe-member-access */
    const requestSessionStatus = (scope as any)._requestSessionStatus;

    if (requestSessionStatus !== undefined) {
      this._incrementSessionCount(requestSessionStatus, new Date());
      // This is not entirely necessarily but is added as a safe guard to indicate the bounds of a request and so in
      // case captureRequestSession is called more than once to prevent double count
      (scope as any)._requestSessionStatus = undefined;

      /* eslint-enable @typescript-eslint/no-unsafe-member-access */
    }
  }

  /**
   * Increments status bucket in pendingAggregates buffer (internal state) corresponding to status of
   * the session received
   */
  private _incrementSessionCount(status: RequestSessionStatus, date: Date): number {
    // Truncate minutes and seconds on Session Started attribute to have one minute bucket keys
    const sessionStartedTrunc: number = new Date(date).setSeconds(0, 0);
    this._pendingAggregates[sessionStartedTrunc] = this._pendingAggregates[sessionStartedTrunc] || {};

    // corresponds to aggregated sessions in one specific minute bucket
    // for example, {"started":"2021-03-16T08:00:00.000Z","exited":4, "errored": 1}
    const aggregationCounts: AggregationCounts = this._pendingAggregates[sessionStartedTrunc];
    if (!aggregationCounts.started) {
      aggregationCounts.started = new Date(sessionStartedTrunc).toISOString();
    }

    switch (status) {
      case RequestSessionStatus.Errored:
        aggregationCounts.errored = aggregationCounts.errored !== undefined ? aggregationCounts.errored + 1 : 1;
        return aggregationCounts.errored;
      case RequestSessionStatus.Ok:
        aggregationCounts.exited = aggregationCounts.exited !== undefined ? aggregationCounts.exited + 1 : 1;
        return aggregationCounts.exited;
    }
  }
}
