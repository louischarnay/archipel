import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { FrontendsController } from './frontends.controller.js';
import { ShellController } from './shell.controller.js';

@Module({ imports: [RuntimeModule], controllers: [ShellController, FrontendsController] })
export class ShellModule {}
