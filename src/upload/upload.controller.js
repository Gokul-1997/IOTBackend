const media = require('../files/media.service');

exports.UploadFile = async (req, res, next) => {
  try {
    const asset = await media.uploadMachineImage(req.user, req.file, req.body?.plant_id);
    res.status(201).json({
      message: 'File uploaded successfully',
      fileUrl: asset.fileUrl,
      asset: { id: asset.id, filename: asset.filename, mime_type: asset.mime_type, size_bytes: asset.size_bytes }
    });
  } catch (error) { next(error); }
};
