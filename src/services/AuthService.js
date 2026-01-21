export default class AuthService {
  constructor(config) {
    this.config = config;
    this.userMap = new Map(
      (config.demoUsers || []).map((user) => [user.token, user])
    );
  }

  async me(token) {
    const user = this.userMap.get(token);
    if (!user) {
      const error = new Error('Invalid or missing token');
      error.statusCode = 401;
      throw error;
    }
    return this.formatUser(user);
  }

  async login({ email, password }) {
    if (!email || !password) {
      const error = new Error('email and password are required');
      error.statusCode = 400;
      throw error;
    }

    if (password !== this.config.demoPassword) {
      const error = new Error('Invalid credentials');
      error.statusCode = 401;
      throw error;
    }

    const user = (this.config.demoUsers || []).find(
      (entry) => entry.email.toLowerCase() === email.toLowerCase()
    );

    if (!user) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }

    return {
      token: user.token,
      user: this.formatUser(user)
    };
  }

  formatUser(user) {
    return {
      id: user.token,
      full_name: user.fullName,
      email: user.email,
      role: user.role,
      app_id: this.config.appId
    };
  }
}
