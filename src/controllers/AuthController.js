import { sendSuccess, sendError } from '../utils/response.js';

export default class AuthController {
  constructor({ authService }) {
    this.authService = authService;
  }

  async me(request, reply) {
    try {
      const user = await this.authService.me(request.user?.token);
      return sendSuccess(reply, user, 'User fetched');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 401);
    }
  }

  async login(request, reply) {
    try {
      const payload = await this.authService.login(request.body);
      return sendSuccess(reply, payload, 'Logged in');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 401);
    }
  }
}
