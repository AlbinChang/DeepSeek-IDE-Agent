import * as fs from 'fs/promises';
import * as path from 'path';
import { formatBeijingIso } from '@/utils/TimeUtils.js';

export interface UserProfile {
    userId: string;
    userName: string;
    registeredAt: string;
}

/**
 * 对应技术规范 3.4 节：用户入驻与身份管理
 */
export class UserService {
    private static REGISTRY_FILE = '.ide-agent/user_registry.json';

    static async registerUser(workspaceRoot: string, userId: string, userName: string): Promise<UserProfile> {
        // 1. 长度限制 10
        if (userId.length > 10 || userName.length > 10) {
            throw new Error('User ID and Name must be 10 characters or less.');
        }

        const registryPath = path.join(workspaceRoot, this.REGISTRY_FILE);
        const users = await this.loadUsers(registryPath);

        // 2. 唯一性校验
        if (users.find(u => u.userId === userId)) {
            throw new Error(`User ID "${userId}" already exists.`);
        }

        const newUser: UserProfile = {
            userId,
            userName,
            registeredAt: formatBeijingIso()
        };

        users.push(newUser);
        await fs.mkdir(path.dirname(registryPath), { recursive: true });
        await fs.writeFile(registryPath, JSON.stringify(users, null, 2));

        return newUser;
    }

    static async getUser(workspaceRoot: string, userId: string): Promise<UserProfile | null> {
        const registryPath = path.join(workspaceRoot, this.REGISTRY_FILE);
        const users = await this.loadUsers(registryPath);
        return users.find(u => u.userId === userId) || null;
    }

    private static async loadUsers(registryPath: string): Promise<UserProfile[]> {
        try {
            const data = await fs.readFile(registryPath, 'utf8');
            return JSON.parse(data);
        } catch {
            return [];
        }
    }

    /**
     * 获取用户专属存放路径 (对齐 18.0 节隔离规范)
     */
    static getUserDataDir(workspaceRoot: string, userId: string): string {
        return path.join(workspaceRoot, '.ide-agent/users', userId);
    }
}
