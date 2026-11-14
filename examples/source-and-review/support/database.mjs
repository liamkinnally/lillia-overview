import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installNativeStore, NativeStore } from '../src/native-store.mjs';

// A file-backed database is part of NativeStore's write contract. Each caller
// owns a new temporary directory and must close it in a finally block or test cleanup.
export function createTemporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), 'lillia-source-example-'));
  const filename = join(directory, 'source.sqlite');
  let db;
  let store;

  // All callbacks are synchronous: this transaction cannot span an await.
  function transaction(callback) {
    if (!db) throw new Error('The example database is closed');
    if (db.isTransaction) throw new Error('Nested transactions are not supported');
    if (typeof callback !== 'function' || callback.constructor?.name === 'AsyncFunction') {
      throw new TypeError('Transactions require a synchronous callback');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        throw new TypeError('Transactions require a synchronous result');
      }
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  function open() {
    const connection = new DatabaseSync(filename);
    try {
      connection.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
      `);
      installNativeStore(connection);
      db = connection;
      store = new NativeStore({ db, transaction });
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  function close() {
    const connection = db;
    db = undefined;
    store = undefined;
    try {
      connection?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  function reopen() {
    if (!db) throw new Error('The example database is closed');
    db.close();
    db = undefined;
    store = undefined;
    try {
      open();
    } catch (error) {
      close();
      throw error;
    }
  }

  try {
    open();
  } catch (error) {
    close();
    throw error;
  }

  return {
    directory,
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    transaction,
    reopen,
    close
  };
}
