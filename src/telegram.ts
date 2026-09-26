import TelegramBot from 'node-telegram-bot-api';

export class TelegramService {
    private bot: TelegramBot;
    private chatId: string;

    constructor(token: string, chatId: string) {
        this.bot = new TelegramBot(token, { polling: true });
        this.chatId = chatId;
    }

    async enviarMensaje(msg: string): Promise<void> {
        try {
            await this.bot.sendMessage(this.chatId, msg, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Error en el envío de Telegram:', error);
        }
    }

    onComando(comando: RegExp, callback: () => Promise<string>) {
        this.bot.onText(comando, async () => {
            const respuesta = await callback();
            await this.enviarMensaje(respuesta);
        });
    }
}