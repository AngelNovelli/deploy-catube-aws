import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common/pipes/validation.pipe';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { getUploadsPath } from './utils/uploads-path';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.use(json({ limit: '500mb' }));
  app.use(urlencoded({ extended: true, limit: '500mb' }));

  const allowedOrigins = [
    'https://catube.up.railway.app',
    'https://catube-steel.vercel.app',
    'https://catube.xyz',
    'https://www.catube.xyz',
    'http://localhost:5173',
    'http://localhost:5174'
  ];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      } else {
        return callback(new Error('Not allowed by CORS'));
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe());

  // Servir archivos estáticos desde la carpeta uploads //YA NO SE USA MAS XQ PUSIMOS EL BUCKET
  app.useStaticAssets(getUploadsPath(), {
    prefix: '/uploads/',
  });

  app.useStaticAssets(
    join(__dirname, '..', '..', 'frontend', 'src', 'assets'),
    {
      prefix: '/assets/',
    }
  );

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();