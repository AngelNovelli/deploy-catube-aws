import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { UsersModule } from './users/users.module';
import { ChannelsModule } from './channels/channels.module';
import { AuthModule } from './auth/auth.module';
import { ProductModule } from './product/product.module';
import { StoreModule } from './store/store.module';
import { FriendshipsModule } from './friendships/friendships.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MessagesModule } from './messages/messages.module';
import { RoomsModule } from './rooms/rooms.module';
import { SubscriptionsModule } from './subs/subs.module';
import { VideosModule } from './videos/videos.module';
import { TagsModule } from './tags/tags.module';
import { CommentsModule } from './comments/comments.module';
import { PostsModule } from './posts/posts.module';
import { LikesModule } from './likes/likes.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatGateway } from './chat/chat.gateway';

import { User } from './users/entities/user.entity';
import { Channel } from './channels/entities/channel.entity';
import { Store } from './store/entities/store.entity';
import { Product } from './product/entities/product.entity';
import { Video } from './videos/entities/video.entity';
import { Comment } from './comments/entities/comment.entity';
import { Like } from './likes/entities/like.entity';
import { Subscription } from './subs/entities/sub.entity';
import { Friendship } from './friendships/entities/friendship.entity';
import { Notification } from './notifications/entities/notification.entity';
import { Message } from './messages/entities/message.entity';
import { Room } from './rooms/entities/room.entity';
import { Tag } from './tags/entities/tag.entity';
import { Post } from './posts/entities/post.entity';
import { History } from './users/entities/history.entity';
import { WatchLater } from './users/entities/watch-later.entity';
// import { UploadsModule } from './uploads/uploads.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['.env', 'config.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      isGlobal: true,
    }),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql',
        host: config.get<string>('DB_HOST'),
        port: parseInt(config.get<string>('DB_PORT') ?? '3306', 10),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASS'),
        database: config.get<string>('DB_NAME'),
        entities: [
          User, Channel, Store, Product, Video, Comment, Like,
          Subscription, Friendship, Notification, Message,
          Room, Tag, Post, History, WatchLater
        ],
        synchronize: true,
        timezone: 'Z',
      }),
    }),

    UsersModule,
    ChannelsModule,
    AuthModule,
    ProductModule,
    StoreModule,
    FriendshipsModule,
    NotificationsModule,
    MessagesModule,
    RoomsModule,
    SubscriptionsModule,
    VideosModule,
    TagsModule,
    CommentsModule,
    PostsModule,
    // UploadsModule,
    LikesModule,
  ],
  controllers: [AppController],
  providers: [AppService, ChatGateway],
})
export class AppModule { }