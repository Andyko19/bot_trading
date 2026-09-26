import TelegramBot from 'node-telegram-bot-api';

export class TelegramService {
    private bot: TelegramBot;
    private chatId: string;

    constructor(token: string, chatId: string) {
        this.bot = new TelegramBot(token, { polling: true });
        this.chatId = chatId;

        this.bot.on('polling_error', (error) => {
            console.error('⚠️ [Telegram] Error en ciclo de polling:', error.message);
        });
    }

    async enviarMensaje(msg: string): Promise<void> {
        try {
            await this.bot.sendMessage(this.chatId, msg, { parse_mode: 'Markdown' });
        } catch (error: any) {
            console.error('❌ Error enviando mensaje a Telegram:', error.message);
            try {
                await this.bot.sendMessage(this.chatId, msg.replace(/[*_`\[\]]/g, ''));
            } catch (errFallback) {
                console.error('❌ Falló también el respaldo en texto plano.');
            }
        }
    }

    onComando(comando: RegExp, callback: () => Promise<string>) {
        this.bot.onText(comando, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId.toString()) return;
            try {
                const respuesta = await callback();
                await this.enviarMensaje(respuesta);
            } catch (error: any) {
                await this.enviarMensaje(`⚠️ Error ejecutando comando: ${error.message}`);
            }
        });
    }
}