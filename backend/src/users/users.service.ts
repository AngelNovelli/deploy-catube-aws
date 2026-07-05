import { Injectable, Inject, forwardRef, ConflictException, NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError, Like } from 'typeorm';
import { CreateUserDto } from './dto-users/create-user.dto';
import { User } from './entities/user.entity';
import * as bcrypt from 'bcrypt';
import * as crypto from "crypto";
import { ChannelsService } from 'src/channels/channels.service';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { UpdateUserDto } from './dto-users/update-user.dto';
import { DataSource } from 'typeorm';
import { Room } from 'src/rooms/entities/room.entity';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import * as sharp from 'sharp';

import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { History } from './entities/history.entity';
import { WatchLater } from './entities/watch-later.entity';

@Injectable()
export class UsersService {
    private s3: S3Client;

    constructor(
        @InjectRepository(User)
        private usersRepository: Repository<User>,

        @InjectRepository(History)
        private historyRepository: Repository<History>,

        @InjectRepository(WatchLater)
        private watchLaterRepository: Repository<WatchLater>,

        @Inject(forwardRef(() => ChannelsService))
        private channelsService: ChannelsService,

        private readonly configService: ConfigService,
        private readonly dataSource: DataSource,

        private readonly notificationsService: NotificationsService,

    ) {
        this.s3 = new S3Client({
            region: process.env.AWS_REGION,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
            },
        });
        this.findAll();
    }

    // =================================================================
    // MODO LECTURA: Método de creación de usuario
    // =================================================================

    async create(createUserDto: CreateUserDto): Promise<User> {
        const capitalizedUsername = createUserDto.username.charAt(0).toUpperCase() + createUserDto.username.slice(1);

        // 1 & 2. VALIDACIÓN DE UNICIDAD (Username y Email)
        const existingUserByUsername = await this.usersRepository.findOne({ where: { username: capitalizedUsername } });
        if (existingUserByUsername) {
            throw new ConflictException('Username already exists');
        }

        const existingUserByEmail = await this.usersRepository.findOne({ where: { email: createUserDto.email } });
        if (existingUserByEmail) {
            throw new ConflictException('Email already exists');
        }

        // 3. HASHEO Y GENERACIÓN DE TOKEN
        const salt = await bcrypt.genSalt();
        const hashedPassword = await bcrypt.hash(createUserDto.password, salt);

        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 24 * 3600 * 1000); // Caducidad: 24 horas

        // --- LÓGICA DEL AVATAR POR DEFECTO ---

        // Obtener variables de entorno
        const bucketName = this.configService.get<string>('AWS_BUCKET_NAME');
        const awsRegion = this.configService.get<string>('AWS_REGION');

        // Calcular la clave: Primera letra del nombre de usuario capitalizada + '.png'
        const firstLetter = capitalizedUsername.charAt(0).toUpperCase();
        const normalizedFirstLetter = firstLetter === 'Ñ' ? 'NN' : firstLetter;
        const key = `profile/${normalizedFirstLetter}.png`;



        // Construir la URL completa
        const defaultAvatarUrl = `https://${bucketName}.s3.${awsRegion}.amazonaws.com/${key}`;

        const newUser = this.usersRepository.create({
            username: capitalizedUsername,
            email: createUserDto.email,
            password: hashedPassword,

            avatarUrl: defaultAvatarUrl,

            is_verified: false,
            verification_token: token,
            token_expiry: expiry,
        });

        // 4. INSERCIÓN EN BD Y MANEJO DE ERRORES
        try {
            const savedUser = await this.usersRepository.save(newUser); // Guarda el usuario con token y avatar

            // 5. PREPARACIÓN Y ENVÍO DEL EMAIL
            const BASE_VERIFY_URL = this.configService.get<string>('BACKEND_VERIFY_URL');
            const verificationUrl = `${BASE_VERIFY_URL}?token=${token}`;

            await this.sendVerificationEmail(savedUser.email, verificationUrl);

            // 6. CREACIÓN DEL CANAL
            const defaultChannelDto = {
                channel_name: savedUser.username,
                description: `Welcome to ${savedUser.username} channel!`,
                url: savedUser.username.toLowerCase().replace(/\s+/g, '-'),
            };
            await this.channelsService.create(defaultChannelDto, savedUser);

            // NOTIFICACIÓN AL RECEPTOR (El usuario que recibió la solicitud)
            try {
                await this.notificationsService.createNotification(
                    savedUser.user_id,
                    null,
                    NotificationType.WELCOME,
                    'Welcome to CaTube!',
                    `/profile/${savedUser.user_id}`,
                );
            } catch (e) {
                console.error('Failed to create FRIEND_REQUEST notification:', e);
            }

            return savedUser;
        } catch (error) {
            const uniqueViolationCode = '23505';
            if (error instanceof QueryFailedError && (error as any).code === uniqueViolationCode) {
                const detail = (error as any).detail || error.message;
                if (detail.includes('username')) {
                    throw new ConflictException('Username already exists');
                }
                if (detail.includes('email')) {
                    throw new ConflictException('Email already exists');
                }
            }

            if (error instanceof Error && error.message.includes('transporter')) {
                console.error('Error al enviar el correo:', error);
            }
            throw error;
        }
    }

    // =================================================================
    // Lógica de Verificación del Token
    // =================================================================
    async verifyEmail(token: string): Promise<User> {
        // 1. Buscar el usuario por el token
        const user = await this.usersRepository.findOne({
            where: { verification_token: token }
        });

        if (!user) {
            throw new NotFoundException('Token de verificación inválido o ya utilizado.');
        }

        // 2. Comprobar si ya está verificado
        if (user.is_verified) {
            // Ya está verificado, no hace falta reprocesar.
            return user;
        }

        // 3. Comprobar la caducidad
        if (user.token_expiry && user.token_expiry < new Date()) {
            throw new ConflictException('El token de verificación ha caducado. Por favor, solicite un nuevo enlace.');
        }

        // 4. Verificación exitosa: Actualizar el usuario
        user.is_verified = true;
        user.verification_token = null; 
        user.token_expiry = null;  

        return this.usersRepository.save(user);
    }

    // =================================================================
    // MODO LECTURA: Métodos Existentes
    // =================================================================

    findAll(): Promise<User[]> {
        return this.usersRepository.find();
    }

    async findOneByUsername(username: string): Promise<User | null> {
        return this.usersRepository.findOne({
            where: { username },
            relations: ['channel'],
        });
    }

    async searchUsers(query: string): Promise<Partial<User>[]> {
        const users = await this.usersRepository.find({
            where: {
                username: Like(`%${query}%`),
                is_private: false,
            },
            select: ['user_id', 'username', 'avatarUrl'],
        });

        return users.map(user => ({
            user_id: user.user_id,
            username: user.username,
            avatarUrl: user.avatarUrl,
        }));
    }

    findOneById(id: string): Promise<User | null> {
        return this.usersRepository.findOne({
            where: { user_id: id },
            relations: ['channel'],
        });
    }

    async findMe(userId: string): Promise<Partial<User>> {
        const user = await this.usersRepository.findOne({
            where: { user_id: userId },
            select: [
                'user_id',
                'username',
                'email',
                'avatarUrl',
                'description',
                'is_verified',
                'is_private'
            ],
            relations: ['channel'],
        });

        if (!user) {
            throw new NotFoundException('User not found.');
        }

        return user;
    }

    async updateUser(userId: string, updateData: UpdateUserDto): Promise<Partial<User>> {
        // 1. Obtener el usuario
        const user = await this.usersRepository.findOneBy({ user_id: userId });

        if (!user) {
            throw new NotFoundException('User not found.');
        }

        // 2. Validar y actualizar username
        if (updateData.username && updateData.username !== user.username) {
            const capitalizedUsername = updateData.username.charAt(0).toUpperCase() + updateData.username.slice(1);

            // Verificar unicidad
            const existingUser = await this.usersRepository.findOne({
                where: { username: capitalizedUsername }
            });

            if (existingUser) {
                throw new ConflictException('This username is already in use.');
            }

            user.username = capitalizedUsername;
        }

        // 3. Actualizar description
        if (updateData.description !== undefined) {
            user.description = updateData.description;
        }

        // 4. Actualizar avatarUrl
        if (updateData.avatarUrl !== undefined) {
            user.avatarUrl = updateData.avatarUrl;
        }

        // 5. Comprobación de cambios
        if (!updateData.username && updateData.description === undefined && updateData.avatarUrl === undefined) {
            throw new BadRequestException('No update fields provided or values are the same.');
        }


        try {
            // 6. Guardar cambios
            const savedUser = await this.usersRepository.save(user);

            // 7. Devolver solo campos seguros
            const { password, ...result } = savedUser;
            return {
                user_id: result.user_id,
                username: result.username,
                email: result.email,
                avatarUrl: result.avatarUrl,
                description: result.description,
            };

        } catch (error) {
            console.error('Error al guardar la actualización del usuario:', error);
            throw new Error('Failed to save user updates.');
        }
    }

    async uploadAvatar(userId: string, file: Express.Multer.File): Promise<Partial<User>> {
        const user = await this.usersRepository.findOneBy({ user_id: userId });
        if (!user) {
            throw new NotFoundException('User not found.');
        }

        const isCustomAvatar = user.avatarUrl && user.avatarUrl.includes('/avatar/');
        const isDefaultAvatar = user.avatarUrl && user.avatarUrl.includes('/profile/');

        if (isCustomAvatar && !isDefaultAvatar) {
            try {
                const oldKey = user.avatarUrl!.split('.com/')[1];

                if (oldKey) {
                    await this.s3.send(new DeleteObjectCommand({
                        Bucket: process.env.AWS_BUCKET_NAME!,
                        Key: oldKey
                    }));
                }
            } catch (error) {
                console.error('Error deleting old avatar from S3:', error);
            }
        }

        // Process and upload new avatar
        const avatarUrl = await this.uploadToS3(file, 'avatar');
        user.avatarUrl = avatarUrl;

        const savedUser = await this.usersRepository.save(user);

        const { password, ...result } = savedUser;
        return {
            user_id: result.user_id,
            username: result.username,
            email: result.email,
            avatarUrl: result.avatarUrl,
            description: result.description,
        };
    }

    private async uploadToS3(file: Express.Multer.File, folder: string): Promise<string> {
        try {
            const bucketName = process.env.AWS_BUCKET_NAME!;

            // Process and convert image to WebP
            const processedBuffer = await sharp(file.buffer)
                .resize({ width: 800, withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();

            const newMimeType = 'image/webp';
            const originalNameWithoutExt = file.originalname.split('.').slice(0, -1).join('.');
            const key = `${folder}/${uuidv4()}_${originalNameWithoutExt}.webp`;

            const command = new PutObjectCommand({
                Bucket: bucketName,
                Key: key,
                Body: processedBuffer,
                ContentType: newMimeType,
            });

            await this.s3.send(command);

            return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
        } catch (err) {
            console.error('S3 upload error:', err);
            throw new InternalServerErrorException('Failed to process and upload file to S3');
        }
    }



    async remove(id: string): Promise<void> {
        await this.dataSource.transaction(async manager => {
            const user = await manager.findOne(User, {
                where: { user_id: id },
                relations: [
                    'channel',
                    'comments',
                    'likes',
                    'subscriptions',
                    'sentFriendships',
                    'receivedFriendships',
                    'sentNotifications',
                    'receivedNotifications',
                    'messages',
                    'roomsAsUser1',
                    'roomsAsUser2',
                ],
            });

            if (!user) throw new NotFoundException('User not found');

            // console.log('Rooms como user1:', user.roomsAsUser1.map(r => r.room_id));
            // console.log('Rooms como user2:', user.roomsAsUser2.map(r => r.room_id));

            // Eliminar todas las rooms donde el usuario es user1 o user2
            const roomsToDelete = [...user.roomsAsUser1, ...user.roomsAsUser2];
            if (roomsToDelete.length > 0) {
                await manager.remove(Room, roomsToDelete);
            }

            // Eliminar canal si existe
            if (user.channel) {
                await this.channelsService.remove(user.channel.channel_id);
            }

            // Eliminar usuario (cascade elimina mensajes enviados, comentarios, etc.)
            await manager.remove(User, user);
        });
    }

    // Verificacion de mail
    async sendVerificationEmail(newUserEmail: string, verificationLink: string) {
        console.log(`Preparando email de verificación con Resend...`);
        console.log(`Destinatario: ${newUserEmail}`);
        console.log(`Link: ${verificationLink}`);

        try {
            const resend = new Resend(this.configService.get<string>('RESEND_API_KEY'));

            const { data, error } = await resend.emails.send({
                from: "CaTube Team <no-reply@catube.xyz>",
                to: newUserEmail,
                subject: 'Verify your user',
                html: `
                <p>Welcome to CaTube!</p>
                <p>Please click the button below to verify your account:</p>
                <a href="${verificationLink}"
                   style="background:#90b484;padding:10px 20px;border-radius:30px;
                   color:#1a1a1b;text-decoration:none;font-weight:bold;">
                    Verify
                </a>
                <p>If the button doesn't work, copy this link:</p>
                <p>${verificationLink}</p>
            `
            });

            if (error) {
                console.error('Error enviando email con Resend:', error);
                throw new Error('Email sending failed.');
            }

            console.log('Email enviado correctamente con Resend:', data);

        } catch (error) {
            console.error('Error inesperado al enviar el email:', error);
            throw error;
        }
    }

    // Buscar por email
    async findByEmail(email: string): Promise<User | null> {
        return this.usersRepository.findOne({ where: { email } });
    }

    // Actualizar datos del usuario
    async update(id: string, data: Partial<User>): Promise<User | null> {
        await this.usersRepository.update(id, data);
        return this.usersRepository.findOne({ where: { user_id: id } });
    }

    // Buscar usuario por token de reseteo
    async findOneByResetToken(token: string): Promise<User | null> {
        const users = await this.usersRepository.find();

        for (const user of users) {
            if (!user.reset_password_token) continue;
            const isMatch = await bcrypt.compare(token, user.reset_password_token);
            if (isMatch) return user;
        }

        return null;
    }

    /**
     * Paso 1: Enviar correo con link de restablecimiento
     */
    async sendPasswordResetEmail(email: string): Promise<void> {
        // Buscar usuario
        const user = await this.usersRepository.findOne({ where: { email } });
        if (!user) {
            return;
        }

        // Generar token único
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minuto

        // Guardar token y expiración
        user.reset_password_token = resetToken;
        user.reset_token_expiry = expiry;
        await this.usersRepository.save(user);

        const BASE_RESET_URL = this.configService.get<string>('BACKEND_RESET_URL');
        const resetUrl = `${BASE_RESET_URL}?token=${resetToken}`;

        // Enviar correo
        await this.sendResetPasswordEmail(user.email, resetUrl);
    }

    /**
     * Paso 2: Validar token
     */
    async validateResetToken(token: string): Promise<User> {
        const user = await this.usersRepository.findOne({
            where: { reset_password_token: token },
        });

        if (!user) {
            throw new NotFoundException('Token inválido o ya utilizado.');
        }

        if (user.reset_token_expiry && user.reset_token_expiry < new Date()) {
            throw new ConflictException('El token ha expirado.');
        }

        return user;
    }

    /**
     * Paso 3: Restablecer la contraseña
     */
    async resetPassword(token: string, newPassword: string): Promise<User> {
        const user = await this.usersRepository.findOne({
            where: { reset_password_token: token },
        });

        if (!user) {
            throw new NotFoundException('Token inválido o ya utilizado.');
        }

        if (user.reset_token_expiry && user.reset_token_expiry < new Date()) {
            throw new ConflictException('El token ha expirado.');
        }

        // Hashear la nueva contraseña
        const salt = await bcrypt.genSalt();
        user.password = await bcrypt.hash(newPassword, salt);

        // Limpiar campos del token
        user.reset_password_token = null;
        user.reset_token_expiry = null;

        return this.usersRepository.save(user);
    }

    async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
        const user = await this.usersRepository.findOneBy({ user_id: userId });
        if (!user) throw new NotFoundException('User not found');

        const match = await bcrypt.compare(currentPassword, user.password);
        if (!match) {
            throw new BadRequestException('Current password incorrect');
        }

        const salt = await bcrypt.genSalt();
        user.password = await bcrypt.hash(newPassword, salt);
        await this.usersRepository.save(user);
    }

    async setPrivacy(userId: string, isPrivate: boolean): Promise<Partial<User>> {
        const user = await this.usersRepository.findOneBy({ user_id: userId });
        if (!user) throw new NotFoundException('User not found');
        user.is_private = !!isPrivate;
        const saved = await this.usersRepository.save(user);
        const { password, ...result } = saved;
        return result;
    }

    async deleteMe(userId: string, password: string): Promise<void> {
        const user = await this.usersRepository.findOneBy({ user_id: userId });
        if (!user) throw new NotFoundException('User not found');

        const match = await bcrypt.compare(password, user.password);
        if (!match) throw new BadRequestException('Password incorrect');

        await this.remove(userId);
    }

    /**
     * Enviar correo de restablecimiento
     */
    async sendResetPasswordEmail(userEmail: string, resetLink: string) {
        console.log(`Preparando email de reset con Resend...`);
        console.log(`Destinatario: ${userEmail}`);
        console.log(`Link: ${resetLink}`);

        try {
            const resend = new Resend(this.configService.get<string>('RESEND_API_KEY'));

            const { data, error } = await resend.emails.send({
                from: "CaTube Team <no-reply@catube.xyz>",
                to: userEmail,
                subject: 'Reset your password',
                html: `
                <p>Forgot your password?</p>
                <a href="${resetLink}"
                   style="background:#90b484;padding:10px 20px;border-radius:30px;
                   color:#1a1a1b;text-decoration:none;font-weight:bold;">
                    Reset password
                </a>
                <p>If the button doesn't work, copy this link:</p>
                <p>${resetLink}</p>
                <p>This link expires in 15 minutes.</p>
            `
            });

            if (error) {
                console.error('Error enviando email con Resend:', error);
                throw new Error('Reset email sending failed.');
            }

            console.log('Reset email enviado correctamente con Resend:', data);

        } catch (error) {
            console.error('Error inesperado al enviar el email:', error);
            throw error;
        }
    }

    async sendFeedbackEmail(userId: string, feedback: string): Promise<void> {
        const user = await this.usersRepository.findOne({
            where: { user_id: userId },
        });
        const remitenteEmail = user?.email;

        const resend = new Resend(this.configService.get<string>('RESEND_API_KEY'));
        const DESTINO = "catubeapp@gmail.com";

        // El remitente será el correo proporcionado o 'Anónimo'
        const remitenteDisplay = remitenteEmail ? remitenteEmail : "Anónimo";

        const htmlContent = `
        <h1>New Feedback</h1>
        <p> Sender ${remitenteDisplay}</p>
        <hr>
        <p><strong>Feedback message:</strong></p>
        <p style="white-space: pre-wrap; padding: 10px; border: 1px solid #ccc;">${feedback}</p>
    `;

        try {
            await resend.emails.send({
                from: "Formulario de Feedback <no-reply@catube.xyz>",
                to: DESTINO,
                subject: `New Feedback from ${remitenteDisplay}`,
                html: htmlContent,
                replyTo: remitenteEmail || "no-reply@catube.xyz"
            });
            console.log('Feedback enviado a catubeapp@gmail.com');
        } catch (error) {
            console.error('Error enviando email de Feedback con Resend:', error);
            throw new InternalServerErrorException('Error al enviar el correo de feedback.');
        }
    }

    // =================================================================
    // HISTORY & WATCH LATER
    // =================================================================

    async getHistory(userId: string) {
        const history = await this.historyRepository.find({
            where: { user: { user_id: userId } },
            relations: ['video', 'video.channel', 'video.channel.user'],
            order: { viewedAt: 'DESC' },
        });
        return history.map(h => h.video);
    }

    async getWatchLater(userId: string) {
        const wl = await this.watchLaterRepository.find({
            where: { user: { user_id: userId } },
            relations: ['video', 'video.channel', 'video.channel.user'],
            order: { addedAt: 'DESC' },
        });
        return wl.map(w => w.video);
    }

    async addToHistory(userId: string, videoId: string) {
        try {
            // Primero eliminamos cualquier entrada existente
            await this.historyRepository.delete({
                user: { user_id: userId },
                video: { id: videoId }
            });

            // Luego creamos una nueva entrada con el timestamp actualizado
            const historyItem = this.historyRepository.create({
                user: { user_id: userId },
                video: { id: videoId },
                viewedAt: new Date()
            });

            return await this.historyRepository.save(historyItem);
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                console.log('Duplicate entry ignored for history - video already in history');
                return null;
            }
            console.error('Error adding to history:', error);
            throw error;
        }
    }

    async addToWatchLater(userId: string, videoId: string) {
        const exists = await this.watchLaterRepository.findOne({
            where: {
                user: { user_id: userId },
                video: { id: videoId }
            }
        });

        if (exists) {
            return exists;
        }

        const newItem = this.watchLaterRepository.create({
            user: { user_id: userId },
            video: { id: videoId }
        });
        return this.watchLaterRepository.save(newItem);
    }

    async removeFromWatchLater(userId: string, videoId: string) {
        const item = await this.watchLaterRepository.findOne({
            where: {
                user: { user_id: userId },
                video: { id: videoId }
            }
        });

        if (item) {
            return this.watchLaterRepository.remove(item);
        }
        return null;
    }

    async removeFromHistory(userId: string, videoId: string) {
        try {
            const result = await this.historyRepository.delete({
                user: { user_id: userId },
                video: { id: videoId }
            });
            return result.affected! > 0;
        } catch (error) {
            console.error('Error removing from history:', error);
            throw error;
        }
    }

    async clearHistory(userId: string) {
        try {
            const res = await this.historyRepository.delete({ user: { user_id: userId } });
            return { success: true, deleted: res.affected || 0 };
        } catch (err) {
            console.error('Error clearing history:', err);
            throw err;
        }
    }
}
