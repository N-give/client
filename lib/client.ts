/**
 * @license
 * Copyright 2021 Open Ag Data Alliance
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

import { AbortController } from 'node-abort-controller';
import { Buffer } from 'buffer';
import { setTimeout } from 'isomorphic-timers-promises';

import type EventEmitter from 'eventemitter3';
import debug from 'debug';
import deepClone from 'deep-clone';
import { fromBuffer } from 'file-type/core';
import ksuid from 'ksuid';

import {
  createNestedObject,
  fixError,
  getObjectAtPath,
  toArrayPath,
  toStringPath,
} from './utils';
import { HttpClient } from './http';
import { WebSocketClient } from './websocket';

import type { Change, Json, JsonObject } from '.';

const trace = debug('@oada/client:client:trace');
const info = debug('@oada/client:client:info');
const error = debug('@oada/client:client:error');

/**
 * Supported types for in/out request bodies
 *
 * @todo Support more than just Buffer?
 */
export type Body = Json | Buffer;

export type ConnectionRequest = {
  requestId?: string;
  path: string;
  /**
   * @default false
   */
  watch?: boolean;
  method: 'head' | 'get' | 'put' | 'post' | 'delete' | 'unwatch';
  headers: Record<string, string>;
  data?: Body;
} & (
  | { watch?: false }
  | { watch: true; method: 'head' | 'get' | 'put' | 'post' | 'delete' }
);

export interface ConnectionResponse {
  requestId: string | string[];
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data?: Body;
}

export interface ConnectionChange {
  requestId: string[];
  resourceId: string;
  path_leftover: string | string[];
  change: Change[];
}

export type IConnectionResponse = [
  response: ConnectionResponse,
  updates?: AsyncIterableIterator<[Readonly<ConnectionChange>]>
];
export interface Connection extends EventEmitter {
  disconnect(): Promise<void>;
  isConnected(): boolean;
  awaitConnection(): Promise<void>;
  request(
    request: ConnectionRequest,
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<IConnectionResponse>;
}

export interface Config {
  domain: string;
  token?: string;
  /** @default 1 */
  concurrency?: number;
  /** @default 'auto' */
  connection?: 'auto' | 'ws' | 'http' | Connection;
}

export type Response = ConnectionResponse;

export interface WatchResponse<
  C extends Readonly<Change> | ReadonlyArray<Readonly<Change>>
> extends Response {
  /**
   * AsyncIterableIterator of the change feed for the watch
   */
  changes: AsyncIterableIterator<C>;
}

export interface GETRequest {
  path: string;
  tree?: Record<string, unknown>;
  timeout?: number;
}

export interface PersistConfig {
  name: string;
  recordLapsedTimeout: number; // Ms
}

export interface WatchPersist {
  lastRev: number;
  recordLapsedTimeout: number | undefined;
  lastCheck: number | undefined;
  items: Record<number, boolean | number>;
  // Items: {[key: string]: object};
  recorded: Record<number, boolean | number>;
}

export interface WatchRequestBase {
  /**
   * @default 'single'
   */
  type?: 'tree' | 'single';
  /**
   * @default 'head'
   */
  initialMethod?: 'get' | 'head' | 'put' | 'post' | 'delete';
  path: string;
  rev?: number | string;
  persist?: PersistConfig;
  timeout?: number;
}

/**
 * Watch whose callback gets single changes
 */
export interface WatchRequestSingle extends WatchRequestBase {
  type?: 'single';
}
/**
 * @deprecated
 */
export interface WatchRequestSingleOld extends WatchRequestBase {
  type?: 'single';
  watchCallback(response: Readonly<Change>): Promise<void>;
}

/**
 * Watch whose callback gets change trees
 */
export interface WatchRequestTree extends WatchRequestBase {
  type: 'tree';
}
/**
 * @deprecated
 */
export interface WatchRequestTreeOld extends WatchRequestBase {
  type: 'tree';
  watchCallback(response: ReadonlyArray<Readonly<Change>>): Promise<void>;
}

/**
 * Discriminated union of watch for single changes or watch for change trees
 */
export type WatchRequest =
  | WatchRequestSingle
  | WatchRequestTree
  | WatchRequestSingleOld
  | WatchRequestTreeOld;

export interface PUTRequest {
  path: string;
  data: Body;
  contentType?: string;
  revIfMatch?: number; // If-match
  tree?: Record<string, unknown>;
  timeout?: number;
}

export interface POSTRequest {
  path: string;
  data: Body;
  contentType?: string;
  tree?: Record<string, unknown>;
  timeout?: number;
}

export interface HEADRequest {
  path: string;
  timeout?: number;
}

export interface DELETERequest {
  path: string;
  timeout?: number;
}

export interface ENSURERequest {
  path: string;
  timeout?: number;
  tree?: Record<string, unknown>;
  data: Json;
}

/**
 * @internal
 */
export interface OADATree {
  [k: string]: OADATree;
  // @ts-expect-error dumb trees
  _type?: string;
}

/**
 * Handle v2 watch API
 */
async function doWatchCallback<
  C extends Readonly<Change> | ReadonlyArray<Readonly<Change>>
>(
  watch: AsyncIterableIterator<C>,
  watchCallback: (response: C) => Promise<void>,
  requestId: string
) {
  try {
    for await (const change of watch) {
      try {
        await watchCallback(change);
      } catch (cError: unknown) {
        error(cError, `Error in watch callback for watch ${requestId}`);
      }
    }
  } finally {
    await watch.return?.();
  }
}

/**
 * Main  OADAClient class
 */
export class OADAClient {
  #token;
  #domain;
  #concurrency;
  #connection: Connection;
  #persistList: Map<string, WatchPersist>;

  constructor({
    domain,
    token = '',
    concurrency = 1,
    connection = 'http',
  }: Config) {
    // Help for those who can't remember if https should be there
    this.#domain = domain;
    this.#token = token;
    this.#concurrency = concurrency;
    this.#persistList = new Map();
    switch (connection) {
      case 'auto':
        throw new Error('Connection type "auto" is not supported');
      case 'ws':
        this.#connection = new WebSocketClient(this.#domain, this.#concurrency);
        break;
      case 'http':
        this.#connection = new HttpClient(
          this.#domain,
          this.#token,
          this.#concurrency
        );
        break;
      default:
        // Otherwise, they gave us a WebSocketClient to use
        this.#connection = connection;
    }
  }

  /**
   * Repurpose a existing connection to OADA-compliant server with a new token
   * @param token New token.
   */
  public clone(token: string): OADAClient {
    return new OADAClient({
      domain: this.#domain,
      token,
      concurrency: this.#concurrency,
      // Reuse existing WS connection
      connection: this.#connection,
    });
  }

  /**
   * Get the connection token
   */
  public getToken(): string {
    return this.#token;
  }

  /**
   * Get the connection domain
   */
  public getDomain(): string {
    return this.#domain;
  }

  /**
   * Get the connection concurrency
   */
  public getConcurrency(): number {
    return this.#concurrency;
  }

  /** Disconnect from server */
  public async disconnect(): Promise<void> {
    // Close
    return this.#connection.disconnect();
  }

  /** Wait for the connection to open */
  public async awaitConnection(): Promise<void> {
    return this.#connection.awaitConnection();
  }

  /**
   * Send GET request
   * @param request request
   */
  public async get(request: GETRequest): Promise<Response> {
    // ===  Top-level GET ===
    const [topLevelResponse] = await this.#connection.request(
      {
        method: 'get',
        headers: {
          authorization: `Bearer ${this.#token}`,
        },
        path: request.path,
      },
      { timeout: request.timeout }
    );

    // ===  Recursive GET  ===
    if (request.tree) {
      // Get subtree
      const arrayPath = toArrayPath(request.path);
      const subTree = getObjectAtPath(request.tree as OADATree, arrayPath);

      // Replace "data" with the recursive GET result
      topLevelResponse.data = await this.#recursiveGet(
        request.path,
        subTree,
        topLevelResponse.data ?? {}
      );
    }

    // Return top-level response
    return topLevelResponse;
  }

  /**
   * Set up watch
   *
   * @param request watch request
   */
  public watch(
    request: WatchRequestTree
  ): Promise<WatchResponse<ReadonlyArray<Readonly<Change>>>>;
  public watch(
    request: WatchRequestSingle
  ): Promise<WatchResponse<Readonly<Change>>>;
  /** @internal */
  public watch(
    request: WatchRequestTree | WatchRequestSingle
  ): Promise<WatchResponse<Readonly<Change> | ReadonlyArray<Readonly<Change>>>>;
  /**
   * Watch API for v2
   *
   * @deprecated
   */
  public watch(
    request: WatchRequestTreeOld | WatchRequestSingleOld
  ): Promise<string>;
  public async watch(
    request: WatchRequest
  ): Promise<
    WatchResponse<Readonly<Change> | ReadonlyArray<Readonly<Change>>> | string
  > {
    const restart = new AbortController();
    const headers: Record<string, string> = {};

    // TODO: Decide whether this should go after persist to allow it to override the persist rev
    if ('rev' in request) {
      headers['x-oada-rev'] = `${request.rev}`;
    }

    let persistPath = '';
    if (request.persist?.name) {
      const { name, recordLapsedTimeout } = request.persist;
      persistPath = `${request.path}/_meta/watchPersists/${name}`;
      let lastRev: number | undefined;

      const { data } = await this.get({
        path: `${request.path}/_meta`,
      });
      const rev =
        typeof data === 'object' &&
        !Buffer.isBuffer(data) &&
        !Array.isArray(data)
          ? Number(data?._rev)
          : undefined;

      try {
        const { data: r } = await this.get({
          path: persistPath,
        });
        if (typeof r === 'object' && !Buffer.isBuffer(r) && !Array.isArray(r)) {
          lastRev = Number(r?.rev);
          headers['x-oada-rev'] = lastRev.toString();
          trace(
            `Watch persist found _meta entry for [${name}]. Setting x-oada-rev header to ${lastRev}`
          );
        }

        if (!lastRev) {
          trace(
            `Watch persist found _meta entry for [${name}], but 'rev' is undefined. Writing 'rev' as ${rev}`
          );
          await this.put({
            path: `${persistPath}/rev`,
            data: rev!,
          });
          lastRev = Number(rev);
        }
      } catch {
        lastRev = Number(rev);
        let _id;
        if (typeof lastRev === 'number') {
          const { headers: postHeaders } = await this.post({
            path: `/resources`,
            data: { rev: lastRev },
          });
          _id = postHeaders['content-location']?.replace(/^\//, '');
        }

        if (_id) {
          await this.put({
            path: persistPath,
            data: { _id },
          });
          trace(
            `Watch persist did not find _meta entry for [${name}]. Current resource _rev is ${lastRev}. Not setting x-oada-rev header. _meta entry created.`
          );
        }
      }

      // Retrieve list of previously lapsed revs
      let recorded;
      try {
        const { data: revData } = await this.get({
          path: `${persistPath}/items`,
        });
        recorded =
          revData && !Buffer.isBuffer(revData)
            ? (revData as Record<number, boolean | number>)
            : {};
      } catch (cError: unknown) {
        // @ts-expect-error stupid error handling
        if (cError.status === 404) {
          recorded = {};
        } else {
          throw cError as Error;
        }
      }

      this.#persistList.set(persistPath, {
        lastCheck: undefined,
        recordLapsedTimeout,
        lastRev,
        items: {},
        recorded,
      });
    }

    /**
     * Register handler for the "open" event.
     * This event is emitted when 1) this is an initial connection,
     * or 2) the websocket is reconnected.
     * For the initial connection, no special action is needed.
     * For the reconnection case, we need to re-establish the watches.
     */
    this.#connection.on('open', () => {
      restart.abort();
    });

    const { persist, path, timeout, initialMethod: method = 'head' } = request;
    const [response, w] = await this.#connection.request(
      {
        watch: true,
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...headers,
        },
        path,
      },
      { timeout, signal: restart.signal }
    );

    if (response.status !== 200) {
      throw new Error('Watch request failed!');
    }

    // Get requestId from the response
    const requestId: string = Array.isArray(response.requestId)
      ? response.requestId[0]!
      : response.requestId; // Server should always return an array requestId

    async function* handleWatch(this: OADAClient) {
      try {
        for await (const [resp] of w!) {
          let parentRev;

          if (persist) {
            const bod = resp?.change.find((c) => c.path === '')?.body;
            if (
              typeof bod === 'object' &&
              bod !== null &&
              !Array.isArray(bod)
            ) {
              parentRev = bod._rev;
              if (persistPath && this.#persistList.has(persistPath)) {
                this.#persistList.get(persistPath)!.items[Number(parentRev)] =
                  Date.now();
              }
            }
          }

          if (request.type === 'tree') {
            yield deepClone(resp.change);
          } else if (!request.type || request.type === 'single') {
            for (const change of resp.change) {
              yield deepClone(change);

              if (change.path === '') {
                const newRev = change.body?._rev;
                if (newRev) {
                  // WatchRev = newRev;
                  trace(
                    'Updated the rev of request %s to %s',
                    resp.requestId[0],
                    newRev
                  );
                } else {
                  throw new Error('The _rev field is missing.');
                }
              }
            }
          }

          // Persist the new parent rev
          if (
            persist &&
            typeof parentRev === 'number' &&
            this.#persistList.has(persistPath)
          ) {
            await this.#persistWatch(persistPath, parentRev);
          }
        }
      } finally {
        // End the watch once we're done with it
        await this.unwatch(requestId);
      }

      // If the connection died, restart the watch
      if (restart.signal.aborted) {
        // FIXME: Possible stack overflow here?
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const { changes } = await this.watch(request);
        yield* changes;
      }
    }

    // Handle old v2 watch API
    if ('watchCallback' in request) {
      const watch = handleWatch.call(this);
      const { watchCallback } = request;

      // Don't await
      // @ts-expect-error type nonsense
      void doWatchCallback(watch, watchCallback, requestId);
      return requestId;
    }

    const changes = handleWatch.call(this);
    return { ...response, changes };
  }

  public async unwatch(requestId: string): Promise<Response> {
    trace('Unwatch requestId=%s', requestId);

    const [response] = await this.#connection.request({
      path: '',
      headers: {
        authorization: '',
      },
      method: 'unwatch',
      requestId,
    });
    // TODO: add timeout

    return response;
  }

  // GET resource recursively
  async #recursiveGet(
    path: string,
    subTree: OADATree | undefined,
    body: Body | undefined
  ): Promise<Body> {
    // If either subTree or data does not exist, there's mismatch between
    // the provided tree and the actual data stored on the server
    if (!subTree || !body) {
      throw new Error('Path mismatch.');
    }

    // If the object is a link to another resource (i.e., contains "_type"),
    // then perform GET
    if (subTree._type) {
      ({ data: body = {} } = await this.get({ path }));
    }

    // TODO: should this error?
    if (Buffer.isBuffer(body)) {
      return body;
    }

    const data = body;

    // Select children to traverse
    const children: Array<{ treeKey: string; dataKey: string }> = [];
    if ('*' in subTree) {
      // If "*" is specified in the tree provided by the user,
      // get all children from the server
      for (const [key, value] of Object.entries(
        data as Record<string, unknown>
      )) {
        if (typeof value === 'object') {
          children.push({ treeKey: '*', dataKey: key });
        }
      }
    } else {
      // Otherwise, get children from the tree provided by the user
      for (const key of Object.keys(subTree ?? {})) {
        if (typeof data![key as keyof typeof data] === 'object') {
          children.push({ treeKey: key, dataKey: key });
        }
      }
    }

    // Initiate recursive calls
    const promises = children.map(async (item) => {
      const childPath = `${path}/${item.dataKey}`;
      if (!data) {
        return;
      }

      const response = await this.#recursiveGet(
        childPath,
        subTree[item.treeKey],
        (data as JsonObject)[item.dataKey]
      );
      if (Buffer.isBuffer(response)) {
        throw new TypeError('Non JSON is not supported.');
      }

      (data as JsonObject)[item.dataKey] = response;
    });

    await Promise.all(promises);
    return data; // Return object at "path"
  }

  /**
   * Send PUT request
   * @param request PUT request
   */
  public async put(request: PUTRequest): Promise<Response> {
    // Convert string path to array
    // (e.g., /bookmarks/abc/def -> ['bookmarks', 'abc', 'def'])
    const pathArray = toArrayPath(request.path);

    if (request.tree) {
      // Retry counter
      let retryCount = 0;
      // Link object (eventually substituted by an actual link object)
      let linkObject: Json = null;
      let newResourcePathArray: string[] = [];
      for (let index = pathArray.length - 1; index >= 0; index--) {
        // Get current path
        const partialPathArray = pathArray.slice(0, index + 1);
        // Get corresponding data definition from the provided tree
        const treeObject = getObjectAtPath(
          request.tree as OADATree,
          partialPathArray
        );
        if ('_type' in treeObject) {
          // It's a resource
          const contentType = treeObject._type!;
          const partialPath = toStringPath(partialPathArray);
          // Check if resource already exists on the remote server
          // eslint-disable-next-line no-await-in-loop
          const resourceCheckResult = await this.#resourceExists(partialPath);
          if (resourceCheckResult.exist) {
            // CASE 1: resource exists on server.
            // simply create a link using PUT request
            if (linkObject && newResourcePathArray.length > 0) {
              // eslint-disable-next-line no-await-in-loop
              const linkPutResponse = await this.put({
                path: toStringPath(newResourcePathArray),
                contentType,
                data: linkObject,
                // Ensure the resource has not been modified (opportunistic lock)
                revIfMatch: resourceCheckResult.rev,
              }).catch((cError: unknown) => {
                // @ts-expect-error stupid error checking
                if (cError.status === 412) {
                  return cError as Response;
                }

                // @ts-expect-error stupid error checking
                throw new Error(cError.statusText);
              });

              // Handle return code 412 (If-Match failed)
              if (linkPutResponse.status === 412) {
                // Retry with exponential backoff
                if (retryCount++ < 5) {
                  // eslint-disable-next-line no-await-in-loop
                  await setTimeout(
                    100 * (retryCount * retryCount + Math.random())
                  );
                  // Reset loop counter and do tree construction again.
                  index = pathArray.length;
                  continue;
                } else {
                  throw new Error('If-match failed.');
                }
              }
            }

            // We hit a resource that already exists.
            // No need to further traverse the tree.
            break;
          } else {
            // CASE 2: resource does NOT exist on server.
            // create a new nested object containing a link
            const relativePathArray = newResourcePathArray.slice(index + 1);
            const newResource = linkObject
              ? createNestedObject(linkObject, relativePathArray)
              : {};
            // Create a new resource
            // eslint-disable-next-line no-await-in-loop
            const resourceId: string = await this.#createResource(
              contentType,
              newResource as Json
            );
            // Save a link
            linkObject =
              '_rev' in treeObject
                ? { _id: resourceId, _rev: 0 } // Versioned link
                : { _id: resourceId }; // Non-versioned link
            newResourcePathArray = partialPathArray.slice(); // Clone
          }
        }
      }
    }

    // Get content-type
    const contentType =
      request.contentType || // 1) get content-type from the argument
      (Buffer.isBuffer(request.data) &&
        // eslint-disable-next-line unicorn/no-await-expression-member
        (await fromBuffer(request.data))?.mime) ||
      (request.data as JsonObject)?._type || // 2) get content-type from the resource body
      (request.tree
        ? getObjectAtPath(request.tree as OADATree, pathArray)._type // 3) get content-type from the tree
        : 'application/json'); // 4) Assume application/json

    // return PUT response
    const [response] = await this.#connection.request(
      {
        method: 'put',
        headers: {
          'authorization': `Bearer ${this.#token}`,
          'content-type': contentType as string,
          ...(request.revIfMatch && {
            'if-match': request.revIfMatch.toString(),
          }), // Add if-match header if revIfMatch is provided
        },
        path: request.path,
        data: request.data,
      },
      { timeout: request.timeout }
    );
    return response;
  }

  /**
   * Send POST request
   * @param request PUT request
   */
  public async post(request: POSTRequest): Promise<Response> {
    // Convert string path to array
    // (e.g., /bookmarks/abc/def -> ['bookmarks', 'abc', 'def'])
    const pathArray = toArrayPath(request.path);

    const { data, tree, path, timeout } = request;
    if (tree) {
      // We could go to all the trouble of re-implementing tree puts for posts,
      // but it's much easier to just make a ksuid and do the tree put
      const { string: newkey } = await ksuid.random();
      request.path += `/${newkey}`;
      return this.put(request);
    }

    // Get content-type
    const contentType =
      request.contentType ?? // 1) get content-type from the argument
      // eslint-disable-next-line unicorn/no-await-expression-member
      (Buffer.isBuffer(data) && (await fromBuffer(data))?.mime) ??
      (data as JsonObject)?._type ?? // 2) get content-type from the resource body
      (tree
        ? getObjectAtPath(tree, pathArray)._type // 3) get content-type from the tree
        : 'application/json'); // 4) Assume application/json

    // return PUT response
    const [response] = await this.#connection.request(
      {
        method: 'post',
        headers: {
          'authorization': `Bearer ${this.#token}`,
          'content-type': contentType as string,
        },
        path,
        data,
      },
      { timeout }
    );
    return response;
  }

  /**
   * Send HEAD request
   * @param request HEAD request
   */
  public async head(request: HEADRequest): Promise<Response> {
    // Return HEAD response
    const [response] = await this.#connection.request(
      {
        method: 'head',
        headers: {
          authorization: `Bearer ${this.#token}`,
        },
        path: request.path,
      },
      { timeout: request.timeout }
    );
    return response;
  }

  /**
   * Send DELETE request
   * @param request DELETE request
   */
  public async delete(request: DELETERequest): Promise<Response> {
    // Return HEAD response
    const [response] = await this.#connection.request(
      {
        method: 'delete',
        headers: {
          authorization: `Bearer ${this.#token}`,
        },
        path: request.path,
      },
      { timeout: request.timeout }
    );
    return response;
  }

  /**
   * Ensure a particular path with tree exists
   * @param request ENSURERequest
   */
  public async ensure(request: ENSURERequest): Promise<Response> {
    // Return ENSURE response
    try {
      const [response] = await this.#connection.request(
        {
          method: 'head',
          headers: {
            authorization: `Bearer ${this.#token}`,
          },
          path: request.path,
        },
        { timeout: request.timeout }
      );
      return response;
    } catch (cError: unknown) {
      // @ts-expect-error stupid errors
      if (cError.status !== 404) {
        throw cError as Error;
      }

      trace('Path to ensure did not exist. Creating');
      return await this.put(request);
    }
  }

  /** Attempt to save the latest rev processed, accommodating concurrency */
  async #persistWatch(persistPath: string, rev: number): Promise<void> {
    trace(`Persisting watch for path ${persistPath} to rev ${rev}`);
    if (this.#persistList.has(persistPath)) {
      let { lastRev, recorded, items, recordLapsedTimeout, lastCheck } =
        this.#persistList.get(persistPath)!;
      if (recordLapsedTimeout !== undefined) {
        // Handle finished revs that were previously recorded
        if (rev in recorded) {
          info(
            `Lapsed rev [${rev}] on path ${persistPath} is now resolved. Removing from 'items' list.`
          );
          await this.delete({
            path: `${persistPath}/items/${rev}`,
          });
        }

        // Record lapsed revs
        const now = Date.now();
        if (lastCheck === undefined || lastCheck + recordLapsedTimeout > now) {
          await this.#recordLapsedRevs(persistPath, now);
        }

        this.#persistList.get(persistPath)!.lastCheck = now;
      }

      items[Number(rev)] = true;
      while (items[lastRev + 1] === true) {
        // Truthy won't work with items as timestamps
        lastRev++;
        this.#persistList.get(persistPath)!.lastRev = lastRev;
        delete items[Number(lastRev)];
      }

      await this.put({
        path: `${persistPath}/rev`,
        data: lastRev,
      });
      trace('Persisted watch: path: [%s], rev: [%d]', persistPath, lastRev);
    }
  }

  /**
   * Record unfinished revs and bring persisted rev up to date
   */
  async #recordLapsedRevs(persistPath: string, now: number): Promise<void> {
    trace(`Checking for lapsed revs for path [${persistPath}] time: [${now}]`);
    const { items, recorded, recordLapsedTimeout } =
      this.#persistList.get(persistPath)!;
    // Iterate over items;
    for (const [key, item] of Object.entries(items)) {
      if (
        recordLapsedTimeout !== undefined &&
        typeof item === 'number' &&
        now > Number(item) + recordLapsedTimeout
      ) {
        // Record those that have gone stale
        const path = `${persistPath}/items/${key}`;
        info('Recording lapsed rev: %s', path);
        // eslint-disable-next-line no-await-in-loop
        await this.put({
          path,
          data: item,
        });

        // Mark them as resolved
        items[Number(key)] = true;
        recorded[Number(key)] = true;
      }
    }
  }

  /** Create a new resource. Returns resource ID */
  async #createResource(contentType: string, data: Json): Promise<string> {
    // Create unique resource ID
    // eslint-disable-next-line unicorn/no-await-expression-member
    const resourceId = `resources/${(await ksuid.random()).string}`;
    // Append resource ID and content type to object
    // const fullData = { _id: resourceId, _type: contentType, ...data };
    // send PUT request
    await this.put({
      path: `/${resourceId}`,
      data,
      contentType,
    });
    // Return resource ID
    return resourceId;
  }

  /**
   * Check if the specified path exists. Returns boolean value.
   */
  async #resourceExists(
    path: string
  ): Promise<{ exist: boolean; rev?: number }> {
    // In tree put to /resources, the top-level "/resources" should
    // look like it exists, even though oada doesn't allow GET on /resources
    // directly.
    if (path === '/resources') {
      return { exist: true };
    }

    // Otherwise, send HEAD request for resource
    try {
      const headResponse = await this.head({
        path,
      });
      // Check status value
      if (headResponse.status === 200) {
        return { exist: true, rev: Number(headResponse.headers['x-oada-rev']) };
      }

      if (headResponse.status === 404) {
        return { exist: false };
      }
    } catch (cError: unknown) {
      // @ts-expect-error stupid stupid error handling
      if (cError.status === 404) {
        return { exist: false };
      }

      // @ts-expect-error stupid stupid error handling
      if (cError.status === 403 && path.startsWith('/resources')) {
        // 403 is what you get on resources that don't exist (i.e. Forbidden)
        return { exist: false };
      }

      throw await fixError(cError as Error);
      /*
      throw new Error(
        // @ts-expect-error stupid stupid error handling
        `Error: head for resource returned ${cError.statusText ?? cError}`
      );
      */
    }

    throw new Error('Status code is neither 200 nor 404.');
  }
}
