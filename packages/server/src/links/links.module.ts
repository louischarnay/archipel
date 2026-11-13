import { Module } from '@nestjs/common';
import { LinksController } from './links.controller.js';

@Module({ controllers: [LinksController] })
export class LinksModule {}
