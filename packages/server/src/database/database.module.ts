import { Global, Module } from '@nestjs/common';
import { CONFIG } from '../config/tokens.js';
import type { Config } from '../types.js';
import { DATABASE, openDatabase } from './database.js';
import { Store } from './store.js';

// The connection is opened once, from the configuration, and shared by every module.
@Global()
@Module({
  providers: [{ provide: DATABASE, useFactory: (config: Config) => openDatabase(config), inject: [CONFIG] }, Store],
  exports: [DATABASE, Store],
})
export class DatabaseModule {}
