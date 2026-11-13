import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { CommandsController } from './commands.controller.js';

@Module({ imports: [RuntimeModule], controllers: [CommandsController] })
export class CommandsModule {}
