import discord
from discord.ext import tasks, commands
from discord.ui import Button, View, Select
import requests
import json
import os
import time
import re
import google.generativeai as genai
from flask import Flask, request, jsonify
from threading import Thread
from pymongo import MongoClient

# --- НАСТРОЙКИ ---
TOKEN = os.getenv('DISCORDTOKEN')
UPDATE_CHANNEL_ID = 1461974088334446704
ROBLOX_CHANNEL_ID = 1467906321490641109
EXPLOIT_CHANNEL_ID = 1471880566306504754
ROLE_CHANNEL_ID = 1472109649053356139
AI_CHANNEL_ID = 1475235177818230964

AI_WEBHOOK_URL = "https://discord.com/api/webhooks/1475241998192738465/3oizxu-P-te46UHTQYspsI056qAUnT9TwwM8YDLeiJTQIx1VmoTdhdaZtiiNb4bMwjmO"
AI_AVATAR_URL = "https://i.ibb.co/C3m2BskD/Nexus-AI-Icon.png"

ROLE_SCRIPT_ID = 1472108709059625034
ROLE_EXECUTER_ID = 1472108653552337049
ROLE_ROBLOX_ID = 1472108155138867251
OWNER_ROLE_ID = 1467919040671387872

# --- MONGODB ---
MONGO_URI = os.getenv('MONGODB_URI')
mongo_client = MongoClient(MONGO_URI)
db = mongo_client["nexusbot"]
col_config = db["config"]
col_history = db["roblox_history"]
col_ai = db["ai_histories"]

def db_get(key, default=None):
    doc = col_config.find_one({"_id": key})
    return doc["value"] if doc else default

def db_set(key, value):
    col_config.update_one({"_id": key}, {"$set": {"value": value}}, upsert=True)

def get_version_history():
    doc = col_history.find_one({"_id": "history"})
    return doc["versions"] if doc else []

def save_version_history(versions):
    col_history.update_one({"_id": "history"}, {"$set": {"versions": versions}}, upsert=True)

def get_user_history(uid):
    doc = col_ai.find_one({"_id": str(uid)})
    return doc["history"] if doc else []

def save_user_history(uid, history):
    col_ai.update_one({"_id": str(uid)}, {"$set": {"history": history}}, upsert=True)

def delete_user_history(uid):
    col_ai.delete_one({"_id": str(uid)})

# --- НАСТРОЙКА ИИ ---
RAW_AI_KEY = os.getenv('GEMMA_KEY')
if RAW_AI_KEY:
    AI_KEY = RAW_AI_KEY.strip().replace('"', '').replace("'", "")
    genai.configure(api_key=AI_KEY)
else:
    AI_KEY = None

generation_config = {
    "temperature": 0.8,
    "top_p": 0.95,
    "top_k": 40,
    "max_output_tokens": 4096,
}

SYSTEM_PROMPT = (
    "Ты — Nexus AI. Ты дружелюбный ассистент. Используй смайлики редко — только когда это уместно. "
    "Отвечай коротко и по делу. Если вопрос простой — отвечай 1-3 предложениями. "
    "Если пишешь код — используй блоки кода: ```язык\nкод\n```. "
    "Код пиши полностью, не обрезай и не удаляй ничего из предыдущего кода если пользователь не просил об этом. "
    "Не добавляй лишних объяснений если не просят."
)

CURRENT_AI_MODEL = "gemma-3-27b"
MAX_HISTORY = 30

EXCLUDE_LIST = ["RbxCli", "macexploit", "Severe", "Matcha", "Hydrogen", "DX9WARE V2", "Serotonin"]

REPO_CONFIG = {
    "Nexus-Beta-TSB": {"name": "✨ TSB (BETA)", "color": 0x00FFFF},
    "Nexus-Hub-2-SEA": {"name": "🎣 Blox Fruits (Sea 2)", "color": 0xFFA500},
    "Nexus-Hub-Not-Realese-": {"name": "🌊 Blox Fruits (Sea 1)", "color": 0x0000FF},
    "default": {"name": "Nexus Project", "color": 0xcccccc}
}

LANG_EXTENSIONS = {
    "python": ("py", "Python code"), "py": ("py", "Python code"),
    "lua": ("lua", "Lua script"),
    "javascript": ("js", "JavaScript code"), "js": ("js", "JavaScript code"),
    "typescript": ("ts", "TypeScript code"), "ts": ("ts", "TypeScript code"),
    "java": ("java", "Java code"),
    "cpp": ("cpp", "C++ code"), "c++": ("cpp", "C++ code"),
    "c": ("c", "C code"),
    "csharp": ("cs", "CSharp code"), "cs": ("cs", "CSharp code"),
    "html": ("html", "HTML file"), "css": ("css", "CSS file"),
    "bash": ("sh", "Bash script"), "sh": ("sh", "Shell script"),
    "json": ("json", "JSON file"), "sql": ("sql", "SQL script"),
    "rust": ("rs", "Rust code"), "go": ("go", "Go code"),
    "ruby": ("rb", "Ruby code"), "php": ("php", "PHP code"),
    "kotlin": ("kt", "Kotlin code"), "swift": ("swift", "Swift code"),
    "xml": ("xml", "XML file"), "yaml": ("yaml", "YAML file"), "yml": ("yaml", "YAML file"),
}

def extract_code_info(text):
    pattern = r"```(\w*)\n([\s\S]*?)```"
    matches = re.findall(pattern, text)
    if matches:
        lang, code = matches[0]
        return lang.lower().strip(), code.strip()
    return None, None

def get_file_info(lang):
    if lang in LANG_EXTENSIONS:
        ext, label = LANG_EXTENSIONS[lang]
        return ext, label
    return "txt", "Code file"

# --- МИНИ-СЕРВЕР ---
app = Flask('')

@app.route('/')
def home():
    return "Nexus Core System is Online!"

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.json
    if data and 'commits' in data:
        repo_name = data.get('repository', {}).get('name', '')
        info = REPO_CONFIG.get(repo_name, REPO_CONFIG["default"])
        last_commit = data['commits'][0]
        message = last_commit.get('message', 'No description')
        author = last_commit.get('author', {}).get('name', 'Developer')
        bot.loop.create_task(send_github_update(info, message, author))
        return jsonify({"status": "success"}), 200
    return jsonify({"status": "ignored"}), 400

def run_flask():
    app.run(host='0.0.0.0', port=10000)

# --- СОСТОЯНИЕ ---
last_versions = {"live": db_get("live"), "future": db_get("future")}
last_msg_id = [db_get("last_msg_id")]
exploit_msg_id = [db_get("exploit_msg_id")]

def save_state():
    db_set("live", last_versions["live"])
    db_set("future", last_versions["future"])
    db_set("last_msg_id", last_msg_id[0])
    db_set("exploit_msg_id", exploit_msg_id[0])

# --- ПАНЕЛЬ ИИ ---
class AIPanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    def is_owner(self, interaction):
        return any(role.id == OWNER_ROLE_ID for role in interaction.user.roles)

    @discord.ui.button(label="Set Model", style=discord.ButtonStyle.primary, custom_id="panel_setmodel", emoji="⚙️")
    async def setmodel_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.is_owner(interaction):
            return await interaction.response.send_message("❌ Только для Owner.", ephemeral=True)
        embed = discord.Embed(title="⚙️ Смена модели ИИ", description=f"Текущая: `{CURRENT_AI_MODEL}`", color=0x2ecc71)
        await interaction.response.send_message(embed=embed, view=ModelSelectView(), ephemeral=True)

    @discord.ui.button(label="Model", style=discord.ButtonStyle.secondary, custom_id="panel_model", emoji="🤖")
    async def model_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.is_owner(interaction):
            return await interaction.response.send_message("❌ Только для Owner.", ephemeral=True)
        embed = discord.Embed(title="🤖 Доступные модели", color=0x3498db)
        embed.description = (
            f"**Активная:** `{CURRENT_AI_MODEL}`\n\n"
            "• `gemma-3-27b` — Мощная\n"
            "• `gemma-3-12b` — Баланс\n"
            "• `gemma-3-4b` — Лёгкая\n"
            "• `gemma-3-2b` — Ультра лёгкая\n"
            "• `gemini-3-flash` — Быстрая\n"
            "• `gemini-2.5-flash` — Быстрая"
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="Limit", style=discord.ButtonStyle.secondary, custom_id="panel_limit", emoji="📊")
    async def limit_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.is_owner(interaction):
            return await interaction.response.send_message("❌ Только для Owner.", ephemeral=True)
        embed = discord.Embed(title="📊 Лимиты Nexus AI", color=0x9b59b6)
        embed.description = f"• Модель: **{CURRENT_AI_MODEL}**\n• Статус: 🟢 Online\n• Запросы: Unlimited\n• Контекст: до 1M токенов"
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="Last Msg", style=discord.ButtonStyle.success, custom_id="panel_lastmsg", emoji="💬")
    async def lastmsg_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        uid = interaction.user.id
        hist = get_user_history(uid)
        last_ai = None
        for item in reversed(hist):
            if item["role"] == "model":
                last_ai = item["parts"][0] if item["parts"] else None
                break
        if last_ai:
            preview = last_ai[:1900] + ("..." if len(last_ai) > 1900 else "")
            await interaction.response.send_message(f"**Последний ответ ИИ для тебя:**\n{preview}", ephemeral=True)
        else:
            await interaction.response.send_message("ИИ ещё ничего тебе не отвечал.", ephemeral=True)

# --- МЕНЮ МОДЕЛЕЙ ---
class ModelSelect(discord.ui.Select):
    def __init__(self):
        options = [
            discord.SelectOption(label="Gemma 3 27B", value="gemma-3-27b", emoji="🧠"),
            discord.SelectOption(label="Gemma 3 12B", value="gemma-3-12b", emoji="🤖"),
            discord.SelectOption(label="Gemini 3 Flash", value="gemini-3-flash", emoji="⚡"),
            discord.SelectOption(label="Gemini 2.5 Flash", value="gemini-2.5-flash", emoji="🔥"),
            discord.SelectOption(label="Gemma 3 4B", value="gemma-3-4b", emoji="📱"),
            discord.SelectOption(label="Gemma 3 2B", value="gemma-3-2b", emoji="🔋"),
        ]
        super().__init__(placeholder="Выберите модель...", min_values=1, max_values=1, options=options)

    async def callback(self, interaction: discord.Interaction):
        global CURRENT_AI_MODEL
        if not any(role.id == OWNER_ROLE_ID for role in interaction.user.roles):
            return await interaction.response.send_message("❌ Нет прав.", ephemeral=True)
        CURRENT_AI_MODEL = self.values[0]
        await interaction.response.send_message(f"✅ Модель изменена на **{CURRENT_AI_MODEL}**.", ephemeral=True)

class ModelSelectView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=60)
        self.add_item(ModelSelect())

# --- КНОПКИ ИСТОРИИ И РОЛЕЙ ---
class HistoryView(View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Show History", style=discord.ButtonStyle.secondary, custom_id="btn_history")
    async def show_history(self, interaction: discord.Interaction, button: discord.ui.Button):
        vh = get_version_history()
        if not vh:
            return await interaction.response.send_message("History is empty.", ephemeral=True)
        h_list = "**Last 10 recorded versions:**\n\n"
        for v in vh[-10:]:
            link = f"https://rdd.whatexpsare.online/?channel=LIVE&binaryType=WindowsPlayer&version={v}"
            h_list += f"• `{v}` — [Download]({link})\n"
        await interaction.response.send_message(h_list, ephemeral=True)

class RoleView(View):
    def __init__(self):
        super().__init__(timeout=None)

    async def toggle_role(self, interaction: discord.Interaction, role_id: int):
        role = interaction.guild.get_role(role_id)
        if not role:
            return await interaction.response.send_message("Роль не найдена!", ephemeral=True)
        if role in interaction.user.roles:
            await interaction.user.remove_roles(role)
            await interaction.response.send_message(f"❌ Роль **{role.name}** убрана.", ephemeral=True)
        else:
            await interaction.user.add_roles(role)
            await interaction.response.send_message(f"✅ Роль **{role.name}** выдана!", ephemeral=True)

    @discord.ui.button(label="Executer UPD", style=discord.ButtonStyle.primary, custom_id="role_exec")
    async def exec_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.toggle_role(interaction, ROLE_EXECUTER_ID)

    @discord.ui.button(label="Roblox UPD", style=discord.ButtonStyle.success, custom_id="role_roblox")
    async def roblox_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.toggle_role(interaction, ROLE_ROBLOX_ID)

    @discord.ui.button(label="Script UPD", style=discord.ButtonStyle.danger, custom_id="role_script")
    async def script_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.toggle_role(interaction, ROLE_SCRIPT_ID)

# --- ИНИЦИАЛИЗАЦИЯ БОТА ---
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

def send_to_webhook(content, username, avatar_url):
    data = {"content": content, "username": username, "avatar_url": avatar_url}
    requests.post(AI_WEBHOOK_URL, json=data)

def send_file_to_webhook(file_bytes, filename, caption, username, avatar_url):
    files = {"file": (filename, file_bytes, "text/plain")}
    data = {"content": caption, "username": username, "avatar_url": avatar_url}
    requests.post(AI_WEBHOOK_URL, data=data, files=files)

# --- ПАНЕЛЬ В AI КАНАЛЕ ---
async def ensure_ai_panel(channel):
    panel_msg_id = db_get("ai_panel_msg_id")
    if panel_msg_id:
        try:
            await channel.fetch_message(panel_msg_id)
            return
        except:
            db_set("ai_panel_msg_id", None)

    async for msg in channel.history(limit=30):
        if msg.author == bot.user and msg.embeds:
            title = msg.embeds[0].title or ""
            if "Nexus AI" in title and "Panel" in title:
                db_set("ai_panel_msg_id", msg.id)
                return

    embed = discord.Embed(
        title="🤖 Nexus AI | Panel",
        description=(
            "Используй **`?ai <вопрос>`** чтобы пообщаться с ИИ.\n"
            "**`?clear`** — очистить свою историю диалога.\n\n"
            "**Кнопки:**\n"
            "⚙️ **Set Model** — сменить модель *(Owner)*\n"
            "🤖 **Model** — список моделей *(Owner)*\n"
            "📊 **Limit** — лимиты *(Owner)*\n"
            "💬 **Last Msg** — твой последний ответ ИИ\n\n"
            "*ИИ помнит историю отдельно для каждого пользователя.*"
        ),
        color=0x00FBFF
    )
    embed.set_footer(text="Nexus Core | AI System")
    msg = await channel.send(embed=embed, view=AIPanelView())
    db_set("ai_panel_msg_id", msg.id)

# --- ОБРАБОТКА СООБЩЕНИЙ ---
@bot.event
async def on_message(message):
    if message.author == bot.user:
        return

    if message.channel.id == AI_CHANNEL_ID:
        content = message.content.lower()

        if content.startswith(('?ai ', '?аи ')):
            prompt = message.content[4:].strip()
            if not prompt:
                return
            try:
                await message.delete()
            except:
                pass

            uid = message.author.id
            user_hist = get_user_history(uid)

            async with message.channel.typing():
                try:
                    current_model = genai.GenerativeModel(
                        model_name=CURRENT_AI_MODEL,
                        generation_config=generation_config,
                        system_instruction=SYSTEM_PROMPT
                    )

                    user_hist.append({"role": "user", "parts": [prompt]})
                    if len(user_hist) > MAX_HISTORY:
                        user_hist = user_hist[-MAX_HISTORY:]

                    chat = current_model.start_chat(history=user_hist[:-1])
                    response = chat.send_message(prompt)
                    answer_text = response.text

                    user_hist.append({"role": "model", "parts": [answer_text]})
                    if len(user_hist) > MAX_HISTORY:
                        user_hist = user_hist[-MAX_HISTORY:]

                    save_user_history(uid, user_hist)

                    lang, code = extract_code_info(answer_text)
                    caption = f"**Ответ для {message.author.mention}:**"

                    if code and len(code) > 400:
                        ext, label = get_file_info(lang)
                        filename = f"{label}.{ext}"
                        text_only = re.sub(r"```[\w]*\n[\s\S]*?```", "", answer_text).strip()
                        if text_only:
                            caption += f"\n{text_only}"
                        caption += "\n*(Код отправлен файлом)*"
                        send_file_to_webhook(code.encode("utf-8"), filename, caption, "Nexus AI", AI_AVATAR_URL)
                    else:
                        full_answer = f"{caption}\n{answer_text}"
                        if len(full_answer) > 1990:
                            for i in range(0, len(full_answer), 1990):
                                send_to_webhook(full_answer[i:i+1990], "Nexus AI", AI_AVATAR_URL)
                        else:
                            send_to_webhook(full_answer, "Nexus AI", AI_AVATAR_URL)

                except Exception as e:
                    await message.channel.send(
                        f"❌ Ошибка Nexus AI (Модель: `{CURRENT_AI_MODEL}`): {e}",
                        delete_after=15
                    )
            return

        if content.startswith(('?clear', '?клир')):
            try:
                await message.delete()
            except:
                pass
            delete_user_history(message.author.id)
            await message.channel.send(
                f"✅ {message.author.mention}, история диалога очищена.",
                delete_after=10
            )
            return

    await bot.process_commands(message)

# --- КОМАНДЫ ---
@bot.command()
@commands.has_permissions(administrator=True)
async def init_roles(ctx):
    if ctx.channel.id != ROLE_CHANNEL_ID:
        return await ctx.send(f"Эту команду можно использовать только в <#{ROLE_CHANNEL_ID}>")
    embed = discord.Embed(
        title="🔔 Nexus Core | Notifications",
        description=(
            "Выберите роли для уведомлений:\n\n"
            "🔹 **Executer UPD** — Статусы читов\n"
            "🟢 **Roblox UPD** — Обновления Roblox\n"
            "🔴 **Script UPD** — Обновления скриптов"
        ),
        color=0x2b2d31
    )
    await ctx.send(embed=embed, view=RoleView())
    await ctx.message.delete()

@bot.command()
async def version(ctx):
    try:
        await ctx.message.delete()
    except:
        pass
    live = get_roblox_v("live")
    if live:
        await update_roblox_msg(ctx.channel, live, live)

async def send_github_update(info, commit_text, author):
    channel = bot.get_channel(UPDATE_CHANNEL_ID)
    if not channel:
        return
    lines = commit_text.split('\n')
    version_label = lines[0] if lines else "Alpha v1"
    formatted_logs = []
    for line in lines[1:]:
        if not line.strip():
            continue
        low = line.lower()
        emoji = "🟢" if "add" in low else "🔵" if "fix" in low else "🔴" if "rem" in low or "del" in low else "✨"
        formatted_logs.append(f"{emoji} {line.strip()}")
    logs_text = "\n".join(formatted_logs) if formatted_logs else "Update applied"
    embed = discord.Embed(title=f"🚀 {info['name']} : Update", color=info["color"])
    embed.add_field(name="📌 Project", value=f"```{info['name']}```", inline=True)
    embed.add_field(name="👤 Developer", value=f"```{author}```", inline=True)
    embed.add_field(name="✅ Status", value="```Working```", inline=True)
    embed.add_field(name="🆙 Version", value=f"```{version_label}```", inline=False)
    embed.add_field(name="📑 Change Logs", value=logs_text, inline=False)
    embed.set_footer(text=f"Nexus Intel | {time.strftime('%d.%m.%Y')}")
    await channel.send(content=f"<@&{ROLE_SCRIPT_ID}>", embed=embed)

@tasks.loop(minutes=2)
async def check_exploits():
    channel = bot.get_channel(EXPLOIT_CHANNEL_ID)
    if not channel:
        return
    try:
        r = requests.get("https://weao.xyz/api/status/exploits", timeout=10, headers={'User-Agent': 'WEAO-3PService'})
        if r.status_code != 200:
            return
        data = r.json()
    except:
        return

    embed = discord.Embed(title="🛡️ Nexus Exploit Status", color=0x00FBFF)
    status_text = ""
    for entry in data:
        name = entry.get("title", "Unknown")
        if name in EXCLUDE_LIST:
            continue
        is_updated = entry.get("updateStatus", False)
        version = entry.get("version", "N/A")
        is_detected = entry.get("detected", False)
        emoji = "🟢" if is_updated else "🔴"
        detect_warn = "⚠️" if is_detected else ""
        status_text += f"{emoji} **{name}**: `{'Working' if is_updated else 'Patched'}` {detect_warn} | (v{version})\n"

    embed.description = status_text if status_text else "No data available."
    embed.set_footer(text=f"Sync: {time.strftime('%H:%M:%S')} | Powered by WEAO")

    if not exploit_msg_id[0]:
        async for msg in channel.history(limit=10):
            if msg.author == bot.user and msg.embeds and "🛡️ Nexus Exploit Status" in str(msg.embeds[0].title):
                exploit_msg_id[0] = msg.id
                break

    if exploit_msg_id[0]:
        try:
            msg = await channel.fetch_message(exploit_msg_id[0])
            await msg.edit(embed=embed)
        except:
            msg = await channel.send(embed=embed)
            exploit_msg_id[0] = msg.id
    else:
        msg = await channel.send(embed=embed)
        exploit_msg_id[0] = msg.id

    save_state()

def get_roblox_v(channel="live"):
    url = f"https://clientsettings.roblox.com/v2/client-version/WindowsPlayer{'' if channel == 'live' else '/channel/znext'}?t={int(time.time())}"
    try:
        r = requests.get(url, timeout=10, headers={'User-Agent': 'Mozilla/5.0'})
        return r.json().get("clientVersionUpload") if r.status_code == 200 else None
    except:
        return None

async def update_roblox_msg(channel, live, future, is_update=False):
    vh = get_version_history()
    if live and live not in vh:
        vh.append(live)
        if len(vh) > 20:
            vh.pop(0)
        save_version_history(vh)

    if not last_msg_id[0]:
        async for m in channel.history(limit=10):
            if m.author == bot.user and m.embeds and "Roblox" in str(m.embeds[0].title):
                last_msg_id[0] = m.id
                break

    embed = discord.Embed(title="Roblox Status", color=0x2ecc71)
    embed.add_field(
        name="Current Live Hash:",
        value=f"`{live}`\n[Download](https://rdd.whatexpsare.online/?channel=LIVE&binaryType=WindowsPlayer&version={live})",
        inline=False
    )
    embed.set_footer(text=f"Nexus Tracker | {time.strftime('%H:%M')}")
    content = f"<@&{ROLE_ROBLOX_ID}>" if is_update else ""

    if last_msg_id[0]:
        try:
            msg = await channel.fetch_message(last_msg_id[0])
            await msg.edit(content=content, embed=embed, view=HistoryView())
        except:
            msg = await channel.send(content=content, embed=embed, view=HistoryView())
            last_msg_id[0] = msg.id
    else:
        msg = await channel.send(content=content, embed=embed, view=HistoryView())
        last_msg_id[0] = msg.id

    save_state()

@tasks.loop(minutes=1)
async def check_roblox():
    live, future = get_roblox_v("live"), get_roblox_v("znext")
    if live and (live != last_versions["live"] or future != last_versions["future"]):
        channel = bot.get_channel(ROBLOX_CHANNEL_ID)
        if channel:
            last_versions["live"], last_versions["future"] = live, future
            await update_roblox_msg(channel, live, future, is_update=True)

@bot.event
async def on_ready():
    print(f'✅ Nexus Core System Ready | User: {bot.user}')
    bot.add_view(HistoryView())
    bot.add_view(RoleView())
    bot.add_view(AIPanelView())
    if not check_roblox.is_running():
        check_roblox.start()
    if not check_exploits.is_running():
        check_exploits.start()
    ai_channel = bot.get_channel(AI_CHANNEL_ID)
    if ai_channel:
        await ensure_ai_panel(ai_channel)

if __name__ == "__main__":
    Thread(target=run_flask).start()
    bot.run(TOKEN)
