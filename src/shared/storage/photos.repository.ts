import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PhotosRepository {
  constructor(private readonly prisma: PrismaService) {}
  find(id: string) {
    return this.prisma.photo.findUnique({ where: { id } });
  }
}
