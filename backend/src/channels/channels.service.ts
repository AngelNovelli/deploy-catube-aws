import { Injectable, NotFoundException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateChannelDto } from './dto-channels/create-channel.dto';
import { Channel } from './entities/channel.entity';
import { User } from 'src/users/entities/user.entity';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import * as sharp from 'sharp';

@Injectable()
export class ChannelsService {
    private s3: S3Client;

    // --- URLs de Perfil Base para Supabase ---
    private readonly STORAGE_FOLDER_PROFILE = 'profile';
    private readonly STORAGE_FOLDER_BANNERS = 'banners';

    constructor(
        @InjectRepository(Channel)
        private channelRepository: Repository<Channel>,
    ) {
        // Configuración de S3 compatible con Supabase Storage
        this.s3 = new S3Client({
            region: process.env.SUPABASE_REGION || 'us-east-1',
            endpoint: process.env.SUPABASE_ENDPOINT, // Tu endpoint de Supabase
            credentials: {
                accessKeyId: process.env.SUPABASE_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.SUPABASE_SECRET_ACCESS_KEY || '',
            },
            forcePathStyle: true,
        });
    }

    // Helper para armar la URL pública limpia de Supabase sin duplicar strings
    private getPublicUrl(key: string): string {
        const supabaseUrl = process.env.SUPABASE_ENDPOINT?.replace('/storage/v1/s3', '');
        return `${supabaseUrl}/storage/v1/object/public/${process.env.SUPABASE_BUCKET_NAME}/${key}`;
    }

    // Helper para extraer la Key del Storage sin importar cómo venga la URL
    private getStorageKey(url: string, folder: string): string {
        if (url.includes(`/${folder}/`)) {
            return `${folder}/${url.split(`/${folder}/`).pop()}`;
        }
        return url.split('/').pop() || '';
    }

    // ======================================================
    // CREATE CHANNEL
    // ======================================================
    async create(createChannelDto: CreateChannelDto, user: User): Promise<Channel> {
        const newChannel = this.channelRepository.create({
            channel_name: createChannelDto.channel_name,
            description: createChannelDto.description,
            url: createChannelDto.url,
            user: user,
        });

        // Asignar avatar por defecto basado en la primera letra en Supabase
        const firstLetter = newChannel.channel_name.charAt(0).toUpperCase();
        newChannel.photoUrl = this.getPublicUrl(`${this.STORAGE_FOLDER_PROFILE}/${firstLetter}.png`);

        return this.channelRepository.save(newChannel);
    }

    async findAll(includeHidden = false, q?: string): Promise<Channel[]> {
        if (q && q.trim() !== '') {
            const search = `%${q.toLowerCase()}%`;
            const qb = this.channelRepository
                .createQueryBuilder('channel')
                .leftJoinAndSelect('channel.user', 'user')
                .where('LOWER(channel.channel_name) LIKE :search', { search });

            if (!includeHidden) {
                qb.andWhere('channel.isHidden = :isHidden', { isHidden: false });
            }

            return qb.orderBy('channel.channel_name', 'ASC').getMany();
        }

        if (includeHidden) {
            return this.channelRepository.find({ relations: ['user'] });
        }
        return this.channelRepository.find({
            where: { isHidden: false },
            relations: ['user'],
        });
    }

    async findOfficialChannels(): Promise<Channel[]> {
        return this.channelRepository.createQueryBuilder('channel')
            .innerJoinAndSelect('channel.user', 'user')
            .where('user.user_type IN (:...types)', { types: ['admin', 'official'] })
            .getMany();
    }

    async remove(id: string): Promise<void> {
        await this.channelRepository.delete(id);
    }

    async findOneById(id: string): Promise<Channel & { videoCount: number }> {
        const channel = await this.channelRepository.findOneBy({ channel_id: id });
        if (!channel) throw new NotFoundException(`Canal con ID ${id} no encontrado.`);
        const videoCount = await this.getVideoCount(id);
        return { ...channel, videoCount };
    }

    async findOneByUrl(url: string): Promise<Channel & { videoCount: number }> {
        const channel = await this.channelRepository.findOneBy({ url });
        if (!channel) throw new NotFoundException(`Canal con URL @${url} no encontrado.`);
        const videoCount = await this.getVideoCount(channel.channel_id);
        return { ...channel, videoCount };
    }

    async update(id: string, updateChannelDto: CreateChannelDto): Promise<Channel> {
        const channelToUpdate = await this.channelRepository.findOneBy({ channel_id: id });
        if (!channelToUpdate) throw new NotFoundException(`El canal con ID ${id} no fue encontrado.`);

        if (updateChannelDto.url) {
            const newUrl = updateChannelDto.url.toLowerCase().trim();
            const existingChannel = await this.channelRepository.findOne({ where: { url: newUrl } });
            if (existingChannel && existingChannel.channel_id !== id) {
                throw new ConflictException(`La URL @${newUrl} ya está en uso.`);
            }
        }

        Object.assign(channelToUpdate, updateChannelDto);
        return this.channelRepository.save(channelToUpdate);
    }

    async setVisibilityByUserId(userId: string, isHidden: boolean): Promise<Channel> {
        const channel = await this.channelRepository.findOne({ where: { user: { user_id: userId } }, relations: ['user'] });
        if (!channel) throw new NotFoundException('Channel not found for user');
        channel.isHidden = !!isHidden;
        return this.channelRepository.save(channel);
    }

    // ======================================================
    // UPLOAD TO SUPABASE STORAGE (COMPATIBLE CON S3 V3)
    // ======================================================
    private async uploadToS3(file: Express.Multer.File, folder: string): Promise<string> {
        try {
            const bucketName = process.env.SUPABASE_BUCKET_NAME!;

            // 1. Procesar y convertir la imagen a WebP con Sharp
            const processedBuffer = await sharp(file.buffer)
                .resize({ width: 800, withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();

            // 2. Determinar el nuevo nombre de archivo
            const newMimeType = 'image/webp';
            const originalNameWithoutExt = file.originalname.split('.').slice(0, -1).join('.');
            const key = `${folder}/${uuidv4()}_${originalNameWithoutExt}.webp`;

            console.log('Key que se usará en Supabase:', key);

            await this.s3.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: key,
                Body: processedBuffer,
                ContentType: newMimeType,
            }));

            const publicUrl = this.getPublicUrl(key);
            console.log('URL pública de Supabase generada:', publicUrl);

            return publicUrl;
        } catch (err) {
            console.error('Supabase upload error:', err);
            throw new InternalServerErrorException('Failed to process and upload file to Supabase Storage');
        }
    }

    // ======================================================
    // UPLOAD BANNER
    // ======================================================
    async uploadBanner(id: string, file: Express.Multer.File): Promise<Channel> {
        const channel = await this.channelRepository.findOneBy({ channel_id: id });
        if (!channel) throw new NotFoundException(`Canal con ID ${id} no encontrado.`);

        // Eliminar banner anterior de Supabase si existe
        if (channel.bannerUrl && !channel.bannerUrl.startsWith('/assets/')) {
            try {
                const oldKey = this.getStorageKey(channel.bannerUrl, this.STORAGE_FOLDER_BANNERS);
                if (oldKey) {
                    await this.s3.send(new DeleteObjectCommand({
                        Bucket: process.env.SUPABASE_BUCKET_NAME!,
                        Key: oldKey
                    }));
                    console.log(`Banner anterior eliminado de Storage: ${oldKey}`);
                }
            } catch (error) {
                console.error('Error deleting old banner from Supabase:', error);
            }
        }

        const bannerUrl = await this.uploadToS3(file, this.STORAGE_FOLDER_BANNERS);
        channel.bannerUrl = bannerUrl;

        return this.channelRepository.save(channel);
    }

    // ======================================================
    // UPLOAD PHOTO
    // ======================================================
    async uploadPhoto(id: string, file: Express.Multer.File): Promise<Channel> {
        const channel = await this.channelRepository.findOneBy({ channel_id: id });
        if (!channel) throw new NotFoundException(`Canal con ID ${id} no encontrado.`);

        // Patrón para no borrar por error los avatars estáticos de letras (A.png, B.png...)
        const defaultPhotoPattern = /\/profile\/[A-Z]\.png/;

        // Eliminar foto anterior si no es una por defecto
        if (channel.photoUrl && !defaultPhotoPattern.test(channel.photoUrl)) {
            try {
                const oldKey = this.getStorageKey(channel.photoUrl, this.STORAGE_FOLDER_PROFILE);
                if (oldKey) {
                    await this.s3.send(new DeleteObjectCommand({
                        Bucket: process.env.SUPABASE_BUCKET_NAME!,
                        Key: oldKey
                    }));
                    console.log(`Foto anterior personalizada eliminada de Storage: ${oldKey}`);
                }
            } catch (error) {
                console.error('Error al eliminar la foto anterior de Supabase:', error);
            }
        }

        const photoUrl = await this.uploadToS3(file, this.STORAGE_FOLDER_PROFILE);
        channel.photoUrl = photoUrl;

        return this.channelRepository.save(channel);
    }

    // ======================================================
    // SET DEFAULT PHOTO / BANNER
    // ======================================================
    async setDefaultPhoto(id: string): Promise<Channel> {
        const channel = await this.findOneById(id);

        const defaultPhotoPattern = /\/profile\/[A-Z]\.png/;

        // Eliminar foto personalizada previa de Storage si corresponde
        if (channel.photoUrl && !defaultPhotoPattern.test(channel.photoUrl)) {
            try {
                const oldKey = this.getStorageKey(channel.photoUrl, this.STORAGE_FOLDER_PROFILE);
                if (oldKey) {
                    await this.s3.send(new DeleteObjectCommand({
                        Bucket: process.env.SUPABASE_BUCKET_NAME!,
                        Key: oldKey
                    }));
                }
            } catch (error) {
                console.error('Error deleting old custom photo from Storage:', error);
            }
        }

        const firstLetter = channel.channel_name.charAt(0).toUpperCase();
        channel.photoUrl = this.getPublicUrl(`${this.STORAGE_FOLDER_PROFILE}/${firstLetter}.png`);
        
        return this.channelRepository.save(channel);
    }

    async setDefaultBanner(id: string): Promise<Channel> {
        const channel = await this.findOneById(id);

        if (channel.bannerUrl && !channel.bannerUrl.startsWith('/assets/')) {
            try {
                const oldKey = this.getStorageKey(channel.bannerUrl, this.STORAGE_FOLDER_BANNERS);
                if (oldKey) {
                    await this.s3.send(new DeleteObjectCommand({
                        Bucket: process.env.SUPABASE_BUCKET_NAME!,
                        Key: oldKey
                    }));
                }
            } catch (error) {
                console.error('Error deleting old banner from Storage:', error);
            }
        }

        channel.bannerUrl = `/assets/images/studio_media/catube-pc.png`;
        return this.channelRepository.save(channel);
    }

    async getVideoCount(channelId: string): Promise<number> {
        const result = await this.channelRepository
            .createQueryBuilder('channel')
            .leftJoin('channel.videos', 'video')
            .where('channel.channel_id = :channelId', { channelId })
            .select('COUNT(video.id)', 'count')
            .getRawOne();

        return parseInt(result.count) || 0;
    }
}