import { ForbiddenException, Injectable, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
import { Video } from './entities/video.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { UpdateVideoDto } from './dto/update-video.dto';
import { UsersService } from 'src/users/users.service';
import { Subscription } from 'src/subs/entities/sub.entity';
import { NotificationsService } from 'src/notifications/notifications.service';
import { Readable } from 'stream';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegStatic from 'ffmpeg-static';
import * as ffprobeStatic from 'ffprobe-static';
import { v4 as uuidv4 } from 'uuid';
import { NotificationType } from 'src/notifications/entities/notification.entity';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

// Configurar ffmpeg
ffmpeg.setFfmpegPath(ffmpegStatic as any);
ffmpeg.setFfprobePath(ffprobeStatic.path);

@Injectable()
export class VideosService {
  private readonly s3Client;

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private userService: UsersService,

    @InjectRepository(Subscription)
    private subscriptionsRepository: Repository<Subscription>,
    private notificationsService: NotificationsService,

  ) {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT, // Ej: https://id.supabase.co/storage/v1/s3
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true, // Obligatorio para que Supabase entienda la ruta
    });

  }

  // ======================================================
  // CREATE VIDEO (JOB INITIATION)
  // ======================================================
  async create(createVideoDto: CreateVideoDto, userId: string) {
    const user = await this.userService.findOneById(userId);
    if (!user) throw new NotFoundException(`User with ID ${userId} not found`);

    const channel = user.channel;
    if (!channel) throw new NotFoundException(`Channel not found for user ${userId}`);

    // Create initial video record
    const newVideo = this.videoRepository.create({
      ...createVideoDto,
      channel,
      status: 'processing',
      processingProgress: 0,
      url: '',
      thumbnail: '',
      duration: 0,
      type: 'video' // Default
    });

    await this.videoRepository.save(newVideo);
    console.log(`LOG: Job creado para video ID ${newVideo.id}`);

    return newVideo;
  }

  // ======================================================
  // PROCESS VIDEO (BACKGROUND TASK)
  // ======================================================
  async processVideo(videoId: string, files: Express.Multer.File[]) {
    console.log(`LOG: Iniciando procesamiento de fondo para video ${videoId}`);

    // --- URLs de Miniatura por Defecto ---
    const DEFAULT_VIDEO_THUMBNAIL = 'https://catube-uploads.s3.sa-east-1.amazonaws.com/thumbnails/default-video-thumbnail.png';
    const DEFAULT_SHORT_THUMBNAIL = 'https://catube-uploads.s3.sa-east-1.amazonaws.com/thumbnails/default-short-thumbnail.png';
    // ------------------------------------

    try {
      //Cargar las relaciones necesarias para la notificación al final.
      const video = await this.videoRepository.findOne({
        where: { id: videoId },
        relations: ['channel', 'channel.user'],
      });

      if (!video) {
        console.error(`ERROR: Video ${videoId} no encontrado para procesar.`);
        return;
      }

      // 10% - Iniciado
      video.processingProgress = 10;
      await this.videoRepository.save(video);

      const videoFile = files.find(file => file.mimetype.startsWith('video/'));
      if (!videoFile) {
        throw new Error('No video file found');
      }

      // 30% - Analizando duración y clasificando tipo (short/video)
      let duration = 61;
      try {
        console.log(`Analizando duración del video ${videoId}...`);
        // Este método existe y devuelve la duración en segundos
        duration = await this.getVideoDurationFromBuffer(videoFile.buffer, videoFile.mimetype);
        console.log(`Duración detectada: ${duration} segundos`);
      } catch (error) {
        console.error('FFPROBE error, using fallback duration', error);
        console.log(` Usando duración por defecto: ${duration} segundos`);
      }

      video.duration = duration === 0 ? 61 : duration;
      video.type = video.duration <= 60 ? 'short' : 'video';

      console.log(`Clasificación del video ${videoId}: ${video.title}`);
      console.log(`Duración final: ${video.duration} segundos`);
      console.log(`Tipo asignado: ${video.type}`);
      console.log(`Es Short: ${video.duration <= 60 ? 'SÍ ' : 'NO '}`);

      video.processingProgress = 30;
      await this.videoRepository.save(video);

      // 70% - Subiendo Video a S3
      const videoExtension = videoFile.originalname.split('.').pop();
      const videoKey = `videos/${uuidv4()}_${Date.now()}.${videoExtension}`;

      const videoCommand = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME!,
        Key: videoKey,
        Body: videoFile.buffer,
        ContentType: videoFile.mimetype,
      });

      await this.s3Client.send(videoCommand);
      const supabaseUrl = process.env.AWS_ENDPOINT?.replace('/storage/v1/s3', '');
      video.url = `${supabaseUrl}/storage/v1/object/public/${process.env.AWS_BUCKET_NAME}/${videoKey}`;

      video.processingProgress = 70;
      await this.videoRepository.save(video);

      // 90% - Subiendo Thumbnail (si existe) O ASIGNANDO DEFAULT
      const thumbnailFile = files.find(file => file.mimetype.startsWith('image/'));

      if (thumbnailFile) {
        // Caso 1: El usuario SUBIÓ una miniatura, la subimos a S3
        const thumbExtension = thumbnailFile.originalname.split('.').pop();
        const thumbKey = `thumbnails/${uuidv4()}_${Date.now()}.${thumbExtension}`;

        const thumbCommand = new PutObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME!,
          Key: thumbKey,
          Body: thumbnailFile.buffer,
          ContentType: thumbnailFile.mimetype,
        });

        await this.s3Client.send(thumbCommand);
        const supabaseUrl = process.env.AWS_ENDPOINT?.replace('/storage/v1/s3', '');
        video.thumbnail = `${supabaseUrl}/storage/v1/object/public/${process.env.AWS_BUCKET_NAME}/${thumbKey}`;
        console.log(` Miniatura personalizada subida.`);

      } else {
        // Caso 2: El usuario NO SUBIÓ miniatura, asignamos la URL por defecto
        if (video.type === 'short') {
          video.thumbnail = DEFAULT_SHORT_THUMBNAIL;
          console.log(`Asignando miniatura por defecto para SHORT.`);
        } else {
          video.thumbnail = DEFAULT_VIDEO_THUMBNAIL;
          console.log(`Asignando miniatura por defecto para VIDEO.`);
        }
      }

      video.processingProgress = 90;
      await this.videoRepository.save(video);

      // 100% - Completado
      video.status = 'completed';
      video.processingProgress = 100;
      await this.videoRepository.save(video);

      console.log(`LOG: Procesamiento completado para video ${videoId}`);

      try {
        await this.notifySubscribers(video);
      } catch (e) {
        console.error('Failed to send NEW_VIDEO notification:', e);
      }

    } catch (error) {
      console.error(`ERROR: Fallo procesando video ${videoId}`, error);
      await this.videoRepository.update(videoId, {
        status: 'failed',
        processingProgress: 0
      });
    }
  }

  // ======================================================
  // NOTIFICACIÓN DE SUSCRIPTORES AL TERMINAR PROCESO
  // ======================================================
  private async notifySubscribers(video: Video): Promise<void> {
    // Es crucial que 'video' tenga las relaciones channel y channel.user cargadas (ver punto 3)
    if (!video.channel || !video.channel.user) {
      console.error(`ERROR: No se puede notificar a los suscriptores. Faltan datos de canal o usuario para el video ${video.id}`);
      return;
    }

    const videoOwnerId = video.channel.user.user_id;
    const videoId = video.id;
    const videoTitle = video.title;

    try {
      // 1. Encontrar todas las suscripciones al canal del creador
      const subscriptions = await this.subscriptionsRepository.find({
        where: {
          channel: { channel_id: video.channel.channel_id }
        },
        relations: ['user'],
      });

      if (subscriptions.length === 0) {
        console.log(`Video ${videoId}: No hay suscriptores para notificar.`);
        return;
      }

      // 2. Crear y enviar notificaciones a todos los suscriptores
      const notificationPromises = subscriptions.map(sub => {
        const subscriberId = sub.user.user_id;

        // Evitar auto-notificación (opcional)
        if (subscriberId === videoOwnerId) {
          return Promise.resolve();
        }

        const linkTarget = video.type === 'short' ? `/shorts/${videoId}` : `/watch/${videoId}`;
        const notificationContent = `posted a new ${video.type}: ${videoTitle.substring(0, 30)}...`;

        return this.notificationsService.createNotification(
          subscriberId, // Receptor: El suscriptor
          videoOwnerId, // Emisor: El dueño del video
          NotificationType.NEW_VIDEO,
          notificationContent,
          linkTarget,
        );
      });

      await Promise.all(notificationPromises);
      console.log(`Video ${videoId}: ${notificationPromises.length} suscriptores notificados.`);

    } catch (error) {
      console.error(`ERROR: Falló el envío de notificaciones para el video ${videoId}`, error);
    }
  }

  async getJobStatus(id: string) {
    const video = await this.videoRepository.findOne({
      where: { id },
      select: ['status', 'processingProgress', 'type', 'id']
    });
    if (!video) throw new NotFoundException('Video not found');

    // Si está completado, devolvemos también el link para redirección
    const link = video.type === 'short' ? `/shorts/${video.id}` : `/watch/${video.id}`;

    return {
      status: video.status,
      progress: video.processingProgress,
      videoId: video.id,
      link: link
    };
  }

  // ======================================================
  // UPDATE VIDEO
  // ======================================================
  async update(id: string, updateVideoDto: UpdateVideoDto, files?: Express.Multer.File[]) {
    const DEFAULT_VIDEO_THUMBNAIL = 'https://catube-uploads.s3.sa-east-1.amazonaws.com/thumbnails/default-video-thumbnail.png';
    const DEFAULT_SHORT_THUMBNAIL = 'https://catube-uploads.s3.sa-east-1.amazonaws.com/thumbnails/default-short-thumbnail.png';
    // ---------------------------------------------------------------------------------

    const video = await this.videoRepository.findOne({
      where: { id },
      relations: ['channel', 'channel.user', 'tags'],
    });
    if (!video) throw new NotFoundException('Video not found');

    const updates: any = {};
    if (updateVideoDto.title !== undefined) updates.title = updateVideoDto.title;
    if (updateVideoDto.description !== undefined) updates.description = updateVideoDto.description;

    if (files && files.length > 0) {
      const thumbnailFile = files[0];
      if (!thumbnailFile.mimetype.startsWith('image/'))
        throw new InternalServerErrorException('File must be an image');

      const extension = thumbnailFile.originalname.split('.').pop();
      const key = `thumbnails/${uuidv4()}_${Date.now()}.${extension}`;

      try {
        // 1. Subir nueva thumbnail
        const command = new PutObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME!,
          Key: key,
          Body: thumbnailFile.buffer,
          ContentType: thumbnailFile.mimetype,
        });

        await this.s3Client.send(command);
        const url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
        updates.thumbnail = url;

        // 2. Eliminar thumbnail anterior SOLO SI NO ES DEFAULT
        if (video.thumbnail) {
          const isDefaultThumbnail =
            video.thumbnail === DEFAULT_VIDEO_THUMBNAIL ||
            video.thumbnail === DEFAULT_SHORT_THUMBNAIL;

          if (isDefaultThumbnail) {
            console.log(`Thumbnail anterior es por defecto, se omite el borrado de S3.`);
          } else {
            try {
              // Borrar thumbnail anterior
              const oldKey = video.thumbnail.split('/').pop();
              await this.s3Client.send(new DeleteObjectCommand({
                Bucket: process.env.AWS_BUCKET_NAME!,
                Key: `thumbnails/${oldKey}`
              }));
              console.log(`Thumbnail personalizado anterior eliminado de S3.`);
            } catch (deleteError) {
              console.error('Error deleting old custom thumbnail from S3:', deleteError);
            }
          }
        }

      } catch (err) {
        console.error('S3 upload error3:', err);
        throw new InternalServerErrorException('Failed to upload thumbnail to S3');
      }
    }

    Object.assign(video, updates);
    const updatedVideo = await this.videoRepository.save(video);

    return {
      id: updatedVideo.id,
      title: updatedVideo.title,
      description: updatedVideo.description,
      thumbnail: updatedVideo.thumbnail,
      url: updatedVideo.url,
      tags: updatedVideo.tags,
    };
  }

  private async getVideoDurationFromBuffer(buffer: Buffer, mimetype: string): Promise<number> {
    return new Promise((resolve, reject) => {
      // 1. Crear un Readable Stream a partir del Buffer
      const stream = Readable.from(buffer);

      // Determinar formato basado en mimetype
      let format = 'mp4'; // default
      if (mimetype.includes('webm')) format = 'webm';
      else if (mimetype.includes('matroska') || mimetype.includes('mkv')) format = 'matroska';
      else if (mimetype.includes('quicktime') || mimetype.includes('mov')) format = 'mov';
      else if (mimetype.includes('avi')) format = 'avi';

      // 2. Usar el stream como input
      const command = ffmpeg(stream)
        .inputFormat(format);

      command.ffprobe((err, metadata) => {
        if (err) {
          console.error('FFprobe error:', err);
          return reject(new InternalServerErrorException('ffprobe failed to analyze stream.'));
        }
        resolve(metadata.format.duration || 0);
      });
    });
  }

  // ======================================================
  // TODOS LOS MÉTODOS ORIGINALES SE MANTIENEN
  // ======================================================
  async incrementViews(id: string): Promise<void> {
    const video = await this.videoRepository.findOne({ where: { id } });
    if (!video) throw new NotFoundException("Video not found");
    video.views += 1;
    await this.videoRepository.save(video);
  }

  async findAll(q?: string) {
    if (!q || q.trim() === '') {
      return this.videoRepository.find({
        relations: ['channel', 'tags'],
        order: { createdAt: 'DESC' },
      });
    }

    const search = `%${q.toLowerCase()}%`;
    return this.videoRepository
      .createQueryBuilder('video')
      .leftJoinAndSelect('video.channel', 'channel')
      .leftJoinAndSelect('video.tags', 'tag')
      .where('LOWER(video.title) LIKE :search', { search })
      .orWhere('LOWER(video.description) LIKE :search', { search })
      .orWhere('LOWER(channel.channel_name) LIKE :search', { search })
      .orWhere('LOWER(tag.name) LIKE :search', { search })
      .orderBy('video.createdAt', 'DESC')
      .getMany();
  }

  async findAllShorts(q?: string) {
    if (!q || q.trim() === '') {
      return this.videoRepository.find({
        where: { type: 'short' },
        relations: ['channel', 'channel.user', 'tags'],
        order: { createdAt: 'DESC' },
      });
    }

    const search = `%${q.toLowerCase()}%`;
    return this.videoRepository
      .createQueryBuilder('video')
      .leftJoinAndSelect('video.channel', 'channel')
      .leftJoinAndSelect('video.tags', 'tag')
      .where('video.type = :short', { short: 'short' })
      .andWhere(new Brackets(qb => {
        qb.where('LOWER(video.title) LIKE :search', { search })
          .orWhere('LOWER(video.description) LIKE :search', { search })
          .orWhere('LOWER(channel.channel_name) LIKE :search', { search })
          .orWhere('LOWER(tag.name) LIKE :search', { search });
      }))
      .orderBy('video.createdAt', 'DESC')
      .getMany();
  }

  async findAllVideosOnly(q?: string) {
    if (!q || q.trim() === '') {
      return this.videoRepository.find({
        where: { type: 'video' },
        relations: ['channel', 'tags'],
        order: { createdAt: 'DESC' },
      });
    }

    const search = `%${q.toLowerCase()}%`;
    return this.videoRepository
      .createQueryBuilder('video')
      .leftJoinAndSelect('video.channel', 'channel')
      .leftJoinAndSelect('video.tags', 'tag')
      .where('video.type = :video', { video: 'video' })
      .andWhere(new Brackets(qb => {
        qb.where('LOWER(video.title) LIKE :search', { search })
          .orWhere('LOWER(video.description) LIKE :search', { search })
          .orWhere('LOWER(channel.channel_name) LIKE :search', { search })
          .orWhere('LOWER(tag.name) LIKE :search', { search });
      }))
      .orderBy('video.createdAt', 'DESC')
      .getMany();
  }

  async findAllByChannelId(channelId: string) {
    return this.videoRepository.find({
      where: { channel: { channel_id: channelId } },
      relations: ['channel', 'tags'],
      order: { createdAt: 'DESC' },
    });
  }

  async findEducationalVideos() {
    return this.videoRepository
      .createQueryBuilder('video')
      .leftJoinAndSelect('video.channel', 'channel')
      .leftJoinAndSelect('channel.user', 'user')
      .leftJoinAndSelect('video.tags', 'tag')
      .where('tag.name = :tagName', { tagName: 'education' })
      .orderBy('video.createdAt', 'DESC')
      .getMany();
  }

  async findAllByChannel(userId: string) {
    // 1. Verificar Usuario y Canal
    const user = await this.userService.findOneById(userId);
    if (!user) {
      throw new NotFoundException(`User with ${userId} not found`);
    }

    const channel = user.channel;
    if (!channel) {
      throw new NotFoundException(`Channel not found for user ${userId}`);
    }

    const channelId = channel.channel_id;

    const countsResult = await this.videoRepository.createQueryBuilder("video")
      // Joins para Likes y Comentarios
      .leftJoin("video.likes", "like")
      .leftJoin("video.comments", "comment")

      // Seleccionar el ID del video y los conteos calculados
      .select("video.id", "video_id")
      .addSelect("COUNT(DISTINCT like.id)", "likeCount")
      .addSelect("COUNT(DISTINCT comment.id)", "commentCount")

      // Filtrar y agrupar solo por el video
      .where("video.channel_id = :channelId", { channelId: channelId })
      .groupBy("video.id")
      .getRawMany();

    // 3. Mapear los Conteos para Búsqueda Rápida
    const countsMap = countsResult.reduce((map, item) => {
      map[item.video_id] = {
        likes: parseInt(item.likeCount || '0', 10),
        comments: parseInt(item.commentCount || '0', 10)
      };
      return map;
    }, {});

    // 4.Obtener Videos con Relaciones
    const videos = await this.videoRepository.find({
      where: { channel: { channel_id: channelId } },
      relations: ['channel', 'tags'], // Carga tags y canal
      order: { createdAt: 'DESC' },
    });

    return videos.map(video => ({
      ...video,
      video_likeCount: countsMap[video.id]?.likes ?? 0,
      video_commentCount: countsMap[video.id]?.comments ?? 0,
    }));
  }

  async getVideosByTag(tag: string) {
    return this.videoRepository.find({
      where: { tags: { name: tag } },
      relations: ['tags'],
    });
  }

  async findOneById(id: string) {
    const video = await this.videoRepository.findOne({
      where: { id },
      relations: ['channel', 'channel.user', 'tags'],
    });

    if (!video) throw new NotFoundException('Video not found');

    if (!video.channel || !video.channel.user) {
      console.error('Video found but missing channel or user information:', {
        videoId: video.id,
        hasChannel: !!video.channel,
        hasUser: !!video.channel?.user,
      });
      throw new ForbiddenException('Video no tiene información de canal o usuario asociada');
    }

    return video;
  }

  // ======================================================
  // DELETE VIDEO
  // ======================================================
  async remove(id: string, userId: string) {
    const user = await this.userService.findOneById(userId);
    if (!user || !user.channel) throw new NotFoundException('User or Channel not found');

    const video = await this.videoRepository.findOne({
      where: { id },
      relations: ['channel', 'channel.user'],
    });
    if (!video) throw new NotFoundException('Video not found');

    if (video.channel.channel_id !== user.channel.channel_id) {
      throw new ForbiddenException('You cannot delete this video');
    }

    // --- URLs de Miniatura por Defecto ---
    const DEFAULT_VIDEO_THUMBNAIL = 'https://catube-uploads.s3.sa-east-1.amazonaws.com/thumbnails/default-video-thumbnail.png';
    const DEFAULT_SHORT_THUMBNAIL = 'https://catube-uploads.s3.sa-east-1.amazonaws.com/thumbnails/default-short-thumbnail.png';
    // ---------------------------------------------------------------------------------------------

    // Helper para extraer la Key exacta (tanto para videos/ como para thumbnails/) sin importar el dominio
    const getStorageKey = (url: string) => {
      // Buscamos dónde empieza la carpeta dentro de la URL pública de Supabase
      if (url.includes('/videos/')) return `videos/${url.split('/videos/').pop()}`;
      if (url.includes('/thumbnails/')) return `thumbnails/${url.split('/thumbnails/').pop()}`;
      return url.split('/').pop() || '';
    };

    // Eliminar video de Supabase Storage
    if (video.url) {
      try {
        const videoKey = getStorageKey(video.url);
        if (videoKey) {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME!,
            Key: videoKey // ◄ Ahora va la key completa directa: 'videos/uuid_fecha.mp4'
          }));
          console.log(`Video ${id} eliminado de Supabase Storage. Key: ${videoKey}`);
        }
      } catch (error) {
        console.error('Error deleting video from Supabase:', error);
      }
    }

    // Eliminar thumbnail de Supabase Storage
    if (video.thumbnail) {
      const isDefaultThumbnail =
        video.thumbnail === DEFAULT_VIDEO_THUMBNAIL ||
        video.thumbnail === DEFAULT_SHORT_THUMBNAIL;

      if (isDefaultThumbnail) {
        console.log(`Thumbnail para video ${id} es por defecto, se omite el borrado de Storage.`);
      } else {
        try {
          const thumbnailKey = getStorageKey(video.thumbnail);
          if (thumbnailKey) {
            await this.s3Client.send(new DeleteObjectCommand({
              Bucket: process.env.AWS_BUCKET_NAME!,
              Key: thumbnailKey // ◄ 'thumbnails/uuid_fecha.png'
            }));
            console.log(`Thumbnail personalizado para video ${id} eliminado de Supabase Storage. Key: ${thumbnailKey}`);
          }
        } catch (error) {
          console.error('Error deleting custom thumbnail from Supabase:', error);
        }
      }
    }

    await this.videoRepository.remove(video);
    return { message: 'Video deleted successfully' };
  }
}