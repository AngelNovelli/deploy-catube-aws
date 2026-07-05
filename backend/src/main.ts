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
    origin: allowedOrigins, // ◄ NestJS maneja el array nativamente de forma más segura
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'], // ◄ Agregamos OPTIONS explícito
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204, // ◄ Le responde un 204 limpio al navegador en el preflight
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

  const portEnv = process.env.PORT;
  const port = portEnv ? parseInt(portEnv, 10) : 3000;
  
  // Escuchamos en el puerto asignado y forzamos el host 0.0.0.0
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Aplicación corriendo en el puerto: ${port}`);
}
bootstrap();