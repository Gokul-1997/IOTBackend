const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET_KEY,
    },
});

exports.UploadFile = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        // const user_id = req.user_id
        const ext = path.extname(req.file.originalname);
        const filename = `images/${req.file.fieldname}-${Date.now()}${ext}`;

        const uploadParams = {
            Bucket: process.env.AWS_S3_BUCKET,
            Key: filename,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        };

        await s3.send(new PutObjectCommand(uploadParams));

        const fileUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${filename}`;

        res.status(200).json({
            message: "File uploaded successfully",
            fileUrl,
        });
    } catch (error) {
        console.error("S3 Upload error:", error);
        res.status(500).json({ error: "File upload failed" });
    }
};