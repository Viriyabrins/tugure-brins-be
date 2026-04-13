import FileController from '../controllers/FileController.js';

export default async function (fastify) {
  const fileController = new FileController();

  // Upload file
  fastify.post('/files/upload', async (request, reply) => {
    return fileController.uploadFile(request, reply);
  });

  // Delete file
  fastify.delete('/files/:key', async (request, reply) => {
    return fileController.deleteFile(request, reply);
  });

  // List files
  fastify.get('/files', async (request, reply) => {
    return fileController.listFiles(request, reply);
  });

  // Get download URL
  fastify.get('/files/download-url', async (request, reply) => {
    return fileController.getDownloadUrl(request, reply);
  });

  // Get file with URL
  fastify.get('/files/with-url', async (request, reply) => {
    return fileController.getFileWithUrl(request, reply);
  });
}
