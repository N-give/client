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

// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="types.d.ts" />

import { format } from 'url';

import { Config, OADAClient } from './client';
import { autoConnection, parseDomain } from './auto';

/** Create a new instance of OADAClient */
export function createInstance(config: Config): OADAClient {
  return new OADAClient(config);
}

export function normalizeDomain(domain: string) {
  const { hostname, protocol, port } = parseDomain(domain);
  return format({ hostname, protocol, port });
}

/** Create a new instance and wrap it with Promise */
export async function connect({
  connection: proto = 'auto',
  ...config
}: Config & { token: string }): Promise<OADAClient> {
  const connection = proto === 'auto' ? await autoConnection(config) : proto;
  // Create an instance of client and start connection
  const client = new OADAClient({
    ...config,
    domain: normalizeDomain(config.domain),
    connection,
  });
  // Wait for the connection to open
  await client.awaitConnection();
  // Return the instance
  return client;
}

export {
  OADAClient,
  Config,
  GETRequest,
  PUTRequest,
  HEADRequest,
  WatchRequest,
  // These are for developing an external connection (like google apps script):
  ConnectionRequest,
  ConnectionResponse,
  ConnectionChange,
  Connection,
} from './client';

// eslint-disable-next-line @typescript-eslint/ban-types
export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = Json[];
export type JsonObject = { [property in string]?: Json };
export type Json = JsonPrimitive | JsonObject | JsonArray;

export type JsonCompatible<T> = {
  [P in keyof T]: T[P] extends Json
    ? T[P]
    : Pick<T, P> extends Required<Pick<T, P>>
    ? never
    : T[P] extends (() => unknown) | undefined
    ? never
    : JsonCompatible<T[P]>;
};

export interface Change {
  type: 'merge' | 'delete';
  body: JsonObject & { _rev: number | string };
  path: string;
  resource_id: string;
}
