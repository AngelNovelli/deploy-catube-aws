import { S3Client } from "@aws-sdk/client-s3";

export const getS3Client = () => {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
    const region = process.env.AWS_REGION?.trim();

    // Cambiamos el "throw" por un aviso amistoso en consola
    if (!accessKeyId || !secretAccessKey || !region) {
        console.warn("⚠️ AWS S3: Credenciales faltantes. Ignorar si usás Supabase.");
        return null; // Devolvemos null en vez de romper la app
    }

    return new S3Client({
        region: region,
        credentials: {
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey,
        },
    });
};