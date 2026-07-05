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

  // --- URLs de Miniatura por Defecto Globales ---
  private readonly DEFAULT_VIDEO_THUMBNAIL = 'https://catube-uploads.s3.sa-east-1.amazonaws.com/thumbnails/default-video-thumbnail.png';
  private readonly DEFAULT_SHORT_THUMBNAIL = 'https://catube-uploads.s3.sa-east-1.amazonaws.com/thumbnails/default-short-thumbnail.png';

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private userService: UsersService,

    @InjectRepository(Subscription)
    private subscriptionsRepository: Repository<Subscription>,
    private notificationsService: NotificationsService,
  ) {
    console.log("Control de credenciales Supabase:", {
      hasAccessKey: !!process.env.SUPABASE_ACCESS_KEY_ID,
      hasSecretKey: !!process.env.SUPABASE_SECRET_ACCESS_KEY,
      endpoint: process.env.SUPABASE_ENDPOINT,
      bucket: process.env.SUPABASE_BUCKET_NAME
    });

    this.s3Client = new S3Client({
      region: process.env.SUPABASE_REGION || 'us-east-1',
      endpoint: process.env.SUPABASE_ENDPOINT,
      credentials: {
        accessKeyId: process.env.SUPABASE_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.SUPABASE_SECRET_ACCESS_KEY || '',
      },
      forcePathStyle: true,
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

    const newVideo = this.videoRepository.create({
      ...createVideoDto,
      channel,
      status: 'processing',
      processingProgress: 0,
      url: '',
      thumbnail: '',
      duration: 0,
      type: 'video'
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

    try {
      const video = await this.videoRepository.findOne({
        where: { id: videoId },
        relations: ['channel', 'channel.user'],
      });

      if (!video) {
        console.error(`ERROR: Video ${videoId} no encontrado para procesar.`);
        return;
      }

      video.processingProgress = 10;
      await this.videoRepository.save(video);

      const videoFile = files.find(file => file.mimetype.startsWith('video/'));
      if (!videoFile) {
        throw new Error('No video file found');
      }

      let duration = 61;
      try {
        console.log(`Analizando duración del video ${videoId}...`);
        duration = await this.getVideoDurationFromBuffer(videoFile.buffer, videoFile.mimetype);
        console.log(`Duración detectada: ${duration} segundos`);
      } catch (error) {
        console.error('FFPROBE error, using fallback duration', error);
      }

      video.duration = duration === 0 ? 61 : duration;
      video.type = video.duration <= 60 ? 'short' : 'video';

      console.log(`Clasificación del video ${videoId}: ${video.title}`);
      video.processingProgress = 30;
      await this.videoRepository.save(video);

      // Subiendo Video a S3 compatible (Supabase)
      const videoExtension = videoFile.originalname.split('.').pop();
      const videoKey = `videos/${uuidv4()}_${Date.now()}.${videoExtension}`;

      await this.s3Client.send(new PutObjectCommand({
        Bucket: process.env.SUPABASE_BUCKET_NAME!,
        Key: videoKey,
        Body: videoFile.buffer,
        ContentType: videoFile.mimetype,
      }));

      const supabaseUrl = process.env.SUPABASE_ENDPOINT?.replace('/storage/v1/s3', '');
      video.url = `${supabaseUrl}/storage/v1/object/public/${process.env.SUPABASE_BUCKET_NAME}/${videoKey}`;

      video.processingProgress = 70;
      await this.videoRepository.save(video);

      // Subiendo Thumbnail (si existe) O ASIGNANDO DEFAULT
      const thumbnailFile = files.find(file => file.mimetype.startsWith('image/'));

      if (thumbnailFile) {
        const thumbExtension = thumbnailFile.originalname.split('.').pop();
        const thumbKey = `thumbnails/${uuidv4()}_${Date.now()}.${thumbExtension}`;

        await this.s3Client.send(new PutObjectCommand({
          Bucket: process.env.SUPABASE_BUCKET_NAME!,
          Key: thumbKey,
          Body: thumbnailFile.buffer,
          ContentType: thumbnailFile.mimetype,
        }));
        
        video.thumbnail = `${supabaseUrl}/storage/v1/object/public/${process.env.SUPABASE_BUCKET_NAME}/${thumbKey}`;
        console.log(`Miniatura personalizada subida.`);
      } else {
        if (video.type === 'short') {
          video.thumbnail = this.DEFAULT_SHORT_THUMBNAIL;
          console.log(`Asignando miniatura por defecto para SHORT.`);
        } else {
          video.thumbnail = this.DEFAULT_VIDEO_THUMBNAIL;
          console.log(`Asignando miniatura por defecto para VIDEO.`);
        }
      }

      video.processingProgress = 90;
      await this.videoRepository.save(video);

      // 100% - Completado definitivo
      video.status = 'completed';
      video.processingProgress = 100;
      
      // Intentamos guardado final seguro
      await this.videoRepository.save(video);
      console.log(`LOG: Procesamiento completado y guardado para video ${videoId}`);

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
    if (!video.channel || !video.channel.user) {
      console.error(`ERROR: No se puede notificar a los suscriptores. Faltan datos de canal para el video ${video.id}`);
      return;
    }

    const videoOwnerId = video.channel.user.user_id;
    const videoId = video.id;
    const videoTitle = video.title;

    try {
      const subscriptions = await this.subscriptionsRepository.find({
        where: { channel: { channel_id: video.channel.channel_id } },
        relations: ['user'],
      });

      if (subscriptions.length === 0) {
        console.log(`Video ${videoId}: No hay suscriptores para notificar.`);
        return;
      }

      const notificationPromises = subscriptions.map(sub => {
        const subscriberId = sub.user.user_id;
        if (subscriberId === videoOwnerId) return Promise.resolve();

        const linkTarget = video.type === 'short' ? `/shorts/${videoId}` : `/watch/${videoId}`;
        const notificationContent = `posted a new ${video.type}: ${videoTitle.substring(0, 30)}...`;

        return this.notificationsService.createNotification(
          subscriberId,
          videoOwnerId,
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
        await this.s3Client.send(new PutObjectCommand({
          Bucket: process.env.SUPABASE_BUCKET_NAME!,
          Key: key,
          Body: thumbnailFile.buffer,
          ContentType: thumbnailFile.mimetype,
        }));

        const supabaseUrl = process.env.SUPABASE_ENDPOINT?.replace('/storage/v1/s3', '');
        updates.thumbnail = `${supabaseUrl}/storage/v1/object/public/${process.env.SUPABASE_BUCKET_NAME}/${key}`;

        if (video.thumbnail) {
          const isDefaultThumbnail =
            video.thumbnail === this.DEFAULT_VIDEO_THUMBNAIL ||
            video.thumbnail === this.DEFAULT_SHORT_THUMBNAIL;

          if (!isDefaultThumbnail) {
            try {
              const oldKey = video.thumbnail.split('/').pop();
              await this.s3Client.send(new DeleteObjectCommand({
                Bucket: process.env.SUPABASE_BUCKET_NAME!,
                Key: `thumbnails/${oldKey}`
              }));
              console.log(`Thumbnail personalizado anterior eliminado.`);
            } catch (deleteError) {
              console.error('Error deleting old custom thumbnail:', deleteError);
            }
          }
        }
      } catch (err) {
        console.error('S3 upload error3:', err);
        throw new InternalServerErrorException('Failed to upload thumbnail to Supabase');
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
      const stream = Readable.from(buffer);
      let format = 'mp4';
      if (mimetype.includes('webm')) format = 'webm';
      else if (mimetype.includes('matroska') || mimetype.includes('mkv')) format = 'matroska';
      else if (mimetype.includes('quicktime') || mimetype.includes('mov')) format = 'mov';
      else if (mimetype.includes('avi')) format = 'avi';

      ffmpeg(stream)
        .inputFormat(format)
        .ffprobe((err, metadata) => {
          if (err) {
            console.error('FFprobe error:', err);
            return reject(new InternalServerErrorException('ffprobe failed to analyze stream.'));
          }
          resolve(metadata.format.duration || 0);
        });
    });
  }

  // ======================================================
  // OTROS MÉTODOS MANTENIDOS COPIADOS TAL CUAL
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
    const user = await this.userService.findOneById(userId);
    if (!user) throw new NotFoundException(`User with ${userId} not found`);

    const channel = user.channel;
    if (!channel) throw new NotFoundException(`Channel not found for user ${userId}`);

    const channelId = channel.channel_id;

    const countsResult = await this.videoRepository.createQueryBuilder("video")
      .leftJoin("video.likes", "like")
      .leftJoin("video.comments", "comment")
      .select("video.id", "video_id")
      .addSelect("COUNT(DISTINCT like.id)", "likeCount")
      .addSelect("COUNT(DISTINCT comment.id)", "commentCount")
      .where("video.channel_id = :channelId", { channelId: channelId })
      .groupBy("video.id")
      .getRawMany();

    const countsMap = countsResult.reduce((map, item) => {
      map[item.video_id] = {
        likes: parseInt(item.likeCount || '0', 10),
        comments: parseInt(item.commentCount || '0', 10)
      };
      return map;
    }, {});

    const videos = await this.videoRepository.find({
      where: { channel: { channel_id: channelId } },
      relations: ['channel', 'tags'],
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

    const getStorageKey = (url: string) => {
      if (url.includes('/videos/')) return `videos/${url.split('/videos/').pop()}`;
      if (url.includes('/thumbnails/')) return `thumbnails/${url.split('/thumbnails/').pop()}`;
      return url.split('/').pop() || '';
    };

    if (video.url) {
      try {
        const videoKey = getStorageKey(video.url);
        if (videoKey) {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.SUPABASE_BUCKET_NAME!,
            Key: videoKey
          }));
          console.log(`Video ${id} eliminado de Storage.`);
        }
      } catch (error) {
        console.error('Error deleting video from Supabase:', error);
      }
    }

    if (video.thumbnail) {
      const isDefaultThumbnail =
        video.thumbnail === this.DEFAULT_VIDEO_THUMBNAIL ||
        video.thumbnail === this.DEFAULT_SHORT_THUMBNAIL;

      if (!isDefaultThumbnail) {
        try {
          const thumbnailKey = getStorageKey(video.thumbnail);
          if (thumbnailKey) {
            await this.s3Client.send(new DeleteObjectCommand({
              Bucket: process.env.SUPABASE_BUCKET_NAME!,
              Key: thumbnailKey
            }));
            console.log(`Thumbnail eliminado de Storage.`);
          }
        } catch (error) {
          console.error('Error deleting custom thumbnail:', error);
        }
      }
    }

    await this.videoRepository.remove(video);
    return { message: 'Video deleted successfully' };
  }
}