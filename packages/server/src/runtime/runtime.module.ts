import { Module } from '@nestjs/common';
import { Registry } from './registry.js';
import { RunController } from './run.controller.js';

// The mounted apps: their generated CRUD, their sandboxed controllers and the API that reaches them.
@Module({ controllers: [RunController], providers: [Registry], exports: [Registry] })
export class RuntimeModule {}
