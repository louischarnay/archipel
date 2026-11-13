import { Global, Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Knex } from 'knex';
import { AccountModule } from './account/account.module.js';
import { AppsModule } from './apps/apps.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommandsModule } from './commands/commands.module.js';
import { CONFIG, RESTART, type Restart } from './config/tokens.js';
import { DATABASE } from './database/database.js';
import { DatabaseModule } from './database/database.module.js';
import { Store } from './database/store.js';
import { ErrorFilter } from './http/error.filter.js';
import { OpenApiController } from './http/openapi.controller.js';
import { LinksModule } from './links/links.module.js';
import { PipelineModule } from './pipeline/pipeline.module.js';
import { ReleasesModule } from './releases/releases.module.js';
import { Registry } from './runtime/registry.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { ShellModule } from './shell/shell.module.js';
import type { Config } from './types.js';

// Once the HTTP server has stopped: the app containers, then the last audit lines, then the database.
@Injectable()
class Shutdown implements OnApplicationShutdown {
  constructor(
    private readonly registry: Registry,
    private readonly store: Store,
    @Inject(DATABASE) private readonly db: Knex,
  ) {}

  async onApplicationShutdown() {
    this.registry.stopAll();
    await this.store.auditSettled();
    await this.db.destroy();
  }
}

// The configuration is read before NestJS starts, so it is handed to the module rather than loaded by it.
@Global()
@Module({})
class ConfigModule {
  static with(config: Config, restart: Restart): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: RESTART, useValue: restart },
      ],
      exports: [CONFIG, RESTART],
    };
  }
}

@Module({})
export class AppModule {
  static with(config: Config, restart: Restart): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.with(config, restart),
        DatabaseModule,
        AuthModule,
        RuntimeModule,
        PipelineModule,
        AccountModule,
        AppsModule,
        ReleasesModule,
        LinksModule,
        SettingsModule,
        CommandsModule,
        // Last: its catch-all route serves the frontends of apps.
        ShellModule,
      ],
      controllers: [OpenApiController],
      providers: [Shutdown, { provide: APP_FILTER, useClass: ErrorFilter }],
    };
  }
}
