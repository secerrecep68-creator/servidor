# 🚀 Baileys WhatsApp Server (Multi-Sessão)

Servidor Node.js para envio de mensagens no WhatsApp usando Baileys com suporte a até 5 números simultâneos.

## Funcionalidades

- ✅ Conexão via QR Code (multi-device)
- ✅ Até 5 sessões simultâneas
- ✅ Sessões persistentes (reconexão automática)
- ✅ Envio round-robin entre sessões
- ✅ Fila de envio com delay configurável
- ✅ Personalização de mensagem ({{nome}}, {{produto}})
- ✅ API REST completa
- ✅ Docker pronto

## Instalação Local

```bash
npm install
npm start
```

## Deploy com Docker

```bash
docker-compose up -d
```

## Deploy no Railway

1. Crie uma conta em [railway.app](https://railway.app)
2. Conecte seu repositório GitHub
3. Railway detecta automaticamente o `package.json`
4. Defina a variável `PORT=3000` (ou Railway define automaticamente)
5. Deploy automático!

## API Endpoints

### Sessões

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/start` | Inicia nova sessão |
| GET | `/sessions` | Lista todas as sessões |
| GET | `/session/:id` | Detalhes de uma sessão |
| DELETE | `/session/:id` | Remove sessão |

### Mensagens

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/send` | Envia mensagem direta |
| POST | `/queue` | Adiciona à fila (round-robin) |
| GET | `/queue/status` | Status da fila |

### Health Check

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/health` | Status do servidor |

## Exemplos

### Iniciar sessão
```bash
curl -X POST http://localhost:3000/start \
  -H "Content-Type: application/json" \
  -d '{"session_id": "numero1"}'
```

### Enviar mensagem
```bash
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "numero1",
    "phone": "5511999998888",
    "message": "Olá, tudo bem?"
  }'
```

### Enviar para lista (round-robin)
```bash
curl -X POST http://localhost:3000/queue \
  -H "Content-Type: application/json" \
  -d '{
    "recipients": [
      {"phone": "5511999998888", "name": "João"},
      {"phone": "5511888887777", "name": "Maria"}
    ],
    "message": "Olá {{nome}}, tudo bem?",
    "delay_seconds": 7
  }'
```

## Conectando ao Painel (Spam Panel)

Após o deploy, copie a URL pública do servidor (ex: `https://seu-app.railway.app`)
e configure como `BAILEYS_SERVER_URL` no painel.

## Estrutura

```
src/
├── index.js              # Entry point + Express
├── services/
│   ├── SessionManager.js # Gerenciador de sessões Baileys
│   └── MessageQueue.js   # Fila de envio round-robin
├── controllers/
│   ├── sessionController.js
│   └── messageController.js
├── routes/
│   ├── sessions.js
│   └── messages.js
sessions/                 # Dados das sessões (auto-gerado)
```
