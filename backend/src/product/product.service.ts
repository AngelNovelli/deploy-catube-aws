import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { Repository } from 'typeorm';
import { Store } from 'src/store/entities/store.entity';
import { getS3Client } from 'src/aws/s3.config';

@Injectable()
export class ProductService {
  private readonly s3Client = getS3Client();

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Store)
    private readonly storeRepository: Repository<Store>,
  ) { }

  async create(createProductDto: CreateProductDto, userId: string, file?: any) {
    const store = await this.storeRepository.findOne({
      where: { channel: { user: { user_id: userId } } },
    });

    if (!store) {
      throw new NotFoundException(`Store for user with ID ${userId} not found.`);
    }

    const newProduct = this.productRepository.create({ ...createProductDto, store });
    await this.productRepository.save(newProduct);

    // Si hay archivo pero no hay cliente AWS, tiramos un aviso seguro sin romper la app
    if (file) {
      if (!this.s3Client) {
        console.warn("⚠️ Archivo recibido pero AWS S3 está desactivado. No se guardará imagen.");
      } else {
        try {
          const { PutObjectCommand } = await import("@aws-sdk/client-s3");
          const extension = file.originalname.split('.').pop();
          const key = `products/${newProduct.product_id}_${Date.now()}.${extension}`;

          const command = new PutObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME!,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          });

          await this.s3Client.send(command);
          newProduct.image_url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
          await this.productRepository.save(newProduct);
        } catch (err) {
          console.error("Error subiendo a S3:", err);
        }
      }
    }

    return newProduct;
  }

  findAll() {
    return `This action returns all product`;
  }

  async findMyProducts(userId: string): Promise<Product[]> {
    const store = await this.storeRepository.findOne({
      where: { channel: { user: { user_id: userId } } },
    });

    if (!store) {
      return [];
    }

    return this.productRepository.find({ where: { store: { store_id: store.store_id } } });
  }

  async findProductsByChannel(channelId: string): Promise<Product[]> {
    const store = await this.storeRepository.findOne({
      where: { channel: { channel_id: channelId } },
    });

    if (!store) {
      return [];
    }

    return this.productRepository.find({
      where: { store: { store_id: store.store_id } },
    });
  }

  async findOne(id: string, userId: string): Promise<Product> {
    const product = await this.productRepository.findOne({
      where: { product_id: id },
      relations: ['store', 'store.channel', 'store.channel.user'],
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found.`);
    }

    if (product.store.channel.user.user_id !== userId) {
      throw new UnauthorizedException('You are not authorized to view this product.');
    }

    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto, userId: string, file?: any): Promise<Product> {
    const productToUpdate = await this.findOne(id, userId);
    Object.assign(productToUpdate, updateProductDto);

    if (file) {
      if (!this.s3Client) {
        console.warn("⚠️ AWS S3 desactivado. No se actualizará la imagen.");
      } else {
        try {
          const { PutObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
          const extension = file.originalname.split('.').pop();
          const key = `products/${id}_${Date.now()}.${extension}`;

          await this.s3Client.send(new PutObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME!,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          }));

          const newImageUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

          if (productToUpdate.image_url && productToUpdate.image_url.includes('amazonaws.com')) {
            const oldKey = productToUpdate.image_url.split('/').pop();
            if (oldKey) {
              await this.s3Client.send(new DeleteObjectCommand({
                Bucket: process.env.AWS_BUCKET_NAME!,
                Key: `products/${oldKey}`
              }));
            }
          }

          productToUpdate.image_url = newImageUrl;
        } catch (err) {
          console.error("Error actualizando imagen en S3:", err);
        }
      }
    }

    return this.productRepository.save(productToUpdate);
  }

  async remove(id: string) {
    const product = await this.productRepository.findOne({ where: { product_id: id } });

    if (product?.image_url && product.image_url.includes('amazonaws.com') && this.s3Client) {
      try {
        const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
        const imageKey = product.image_url.split('/').pop();
        if (imageKey) {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME!,
            Key: `products/${imageKey}`
          }));
        }
      } catch (error) {
        console.error('Error deleting product image from S3:', error);
      }
    }

    return this.productRepository.delete(id);
  }

  async removeProductAsOwner(productId: string, userId: string) {
    const product = await this.productRepository.findOne({
      where: { product_id: productId },
      relations: ['store', 'store.channel', 'store.channel.user'],
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found.`);
    }

    if (product.store.channel.user.user_id !== userId) {
      throw new UnauthorizedException('You are not authorized to delete this product.');
    }

    if (product.image_url && product.image_url.includes('amazonaws.com') && this.s3Client) {
      try {
        const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
        const imageKey = product.image_url.split('/').pop();
        if (imageKey) {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME!,
            Key: `products/${imageKey}`
          }));
        }
      } catch (error) {
        console.error('Error deleting product image from S3:', error);
      }
    }

    await this.productRepository.remove(product);
  }
}