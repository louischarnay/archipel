import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { ReleasesController } from './releases.controller.js';

@Module({ imports: [RuntimeModule, PipelineModule], controllers: [ReleasesController] })
export class ReleasesModule {}
