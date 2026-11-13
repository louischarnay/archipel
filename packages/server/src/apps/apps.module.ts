import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { AppsController } from './apps.controller.js';

@Module({ imports: [RuntimeModule, PipelineModule], controllers: [AppsController] })
export class AppsModule {}
