import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

export interface TestContext {
  app: INestApplication;
  dataSource: DataSource;
  /** Base URL of a really-listening server, so concurrency specs issue real parallel requests. */
  baseUrl: string;
}

/**
 * Boots the real application — same pipes, same filter, same middleware as `main.ts`. Nothing is
 * mocked: every invariant under test lives in a transaction, a constraint or a row lock, none of
 * which a mocked repository can observe.
 */
export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  // Port 0: a real listening socket, so `Promise.all` of two requests genuinely races.
  await app.listen(0);

  return {
    app,
    dataSource: app.get(DataSource),
    baseUrl: await app.getUrl(),
  };
}

export async function closeTestApp(context: TestContext): Promise<void> {
  await context.app.close();
}
