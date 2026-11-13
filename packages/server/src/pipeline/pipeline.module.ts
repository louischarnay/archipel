import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { Pipeline } from './pipeline.js';

// From a submitted archive to a live app: validate, scan, preview, test, then wait for a person.
@Module({ imports: [RuntimeModule], providers: [Pipeline], exports: [Pipeline] })
export class PipelineModule {}
