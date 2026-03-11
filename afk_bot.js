// ════════════════════════════════════════════════════════════════════
//  AI_Guardian.js  —  v8.0
//
//  Установка:
//    npm install mineflayer mineflayer-pathfinder mineflayer-collectblock mineflayer-tool
//
//  Запуск:
//    node afk_bot.js [host] [port]
//
//  API ключи — из переменных окружения или вшей в код ниже:
//    GROQ_KEY=gsk_... node afk_bot.js          ← РЕКОМЕНДУЕТСЯ (бесплатно, быстро)
//    CEREBRAS_KEY=csk-... node afk_bot.js       ← Самый быстрый
// ════════════════════════════════════════════════════════════════════
'use strict'

const mineflayer    = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectPlugin = require('mineflayer-collectblock').plugin
const toolPlugin    = require('mineflayer-tool').plugin
const Vec3          = require('vec3')
const https         = require('https')

const HOST    = process.argv[2] || process.env.MC_HOST    || 'jorjinaplay.aternos.me'
const PORT    = parseInt(process.argv[3] || process.env.MC_PORT  || '20942')
const USERNAME = process.argv[4] || process.env.MC_USER    || 'AI_Guardian'
const VERSION  = process.argv[5] || process.env.MC_VERSION || false

// ═══ API КЛЮЧИ (из env или вставь прямо сюда) ════════════════════
const GROQ_KEY     = process.env.GROQ_KEY     || ''
const CEREBRAS_KEY = process.env.CEREBRAS_KEY || ''
const GEMINI_KEY   = process.env.GEMINI_KEY   || ''
const MISTRAL_KEY  = process.env.MISTRAL_KEY  || ''
const HF_TOKEN     = process.env.HF_TOKEN     || ''

// ═══ КОНСТАНТЫ ═══════════════════════════════════════════════════
const FOODS = new Set([
  'apple','bread','steak','porkchop','chicken','cod','salmon',
  'mutton','rabbit','beef','cooked_beef','cooked_chicken','cooked_porkchop',
  'cooked_mutton','cooked_rabbit','cooked_cod','cooked_salmon','cake','cookie',
  'carrot','baked_potato','melon_slice','golden_apple','enchanted_golden_apple',
  'mushroom_stew','rabbit_stew','suspicious_stew','sweet_berries','glow_berries',
  'dried_kelp','chorus_fruit'
])

// Алиасы блоков: когда просят один — ищем все варианты
const BLOCK_ALIASES = {
  diamond_ore:   ['diamond_ore', 'deepslate_diamond_ore'],
  iron_ore:      ['iron_ore',    'deepslate_iron_ore'],
  gold_ore:      ['gold_ore',    'deepslate_gold_ore'],
  coal_ore:      ['coal_ore',    'deepslate_coal_ore'],
  copper_ore:    ['copper_ore',  'deepslate_copper_ore'],
  emerald_ore:   ['emerald_ore', 'deepslate_emerald_ore'],
  lapis_ore:     ['lapis_ore',   'deepslate_lapis_ore'],
  redstone_ore:  ['redstone_ore','deepslate_redstone_ore'],
}

const WEAPON_PRIO = [
  'netherite_sword','diamond_sword','iron_sword','stone_sword','golden_sword','wooden_sword',
  'netherite_axe','diamond_axe','iron_axe','stone_axe','golden_axe','wooden_axe','trident'
]
const AXE_PRIO = ['netherite_axe','diamond_axe','iron_axe','stone_axe','golden_axe','wooden_axe']
const BOW_PRIO = ['bow', 'crossbow']

// Приоритет брони (лучшее → худшее)
const ARMOR_TIERS = ['netherite','diamond','iron','golden','chainmail','leather']
const ARMOR_PIECES = {
  helmet:     { slot: 5,  equipSlot: 'head',  keywords: ['helmet', 'cap', 'hat'] },
  chestplate: { slot: 6,  equipSlot: 'torso', keywords: ['chestplate', 'tunic', 'vest'] },
  leggings:   { slot: 7,  equipSlot: 'legs',  keywords: ['leggings', 'pants', 'greaves'] },
  boots:      { slot: 8,  equipSlot: 'feet',  keywords: ['boots', 'shoes', 'sabaton'] },
}

const EFFECT_SPEED = 1

const FARM_BLUEPRINTS = {
  тростника: (() => {
    const b = []
    for (let i = 0; i < 5; i++) {
      b.push({ dx: i, dy: 0, dz: 0, block: 'dirt' })
      b.push({ dx: i, dy: 1, dz: 0, block: 'sugar_cane' })
    }
    return b
  })(),
  пшеницы: (() => {
    const b = []
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++)
        b.push({ dx: i, dy: 0, dz: j, block: 'farmland' })
    b.push({ dx: 2, dy: 0, dz: -1, block: 'water' })
    return b
  })(),
  деревьев: [
    { dx: 0, dy: 0, dz: 0, block: 'dirt' }, { dx: 0, dy: 1, dz: 0, block: 'oak_sapling' },
    { dx: 3, dy: 0, dz: 0, block: 'dirt' }, { dx: 3, dy: 1, dz: 0, block: 'oak_sapling' },
    { dx: 6, dy: 0, dz: 0, block: 'dirt' }, { dx: 6, dy: 1, dz: 0, block: 'oak_sapling' },
  ],
  автокриперов: (() => {
    const b = []
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++)
        b.push({ dx: i, dy: 0, dz: j, block: 'stone' })
    return b
  })(),
}

const POTION_RECIPES = {
  силы: 'blaze_powder', регенерации: 'ghast_tear', скорости: 'sugar',
  прыжка: 'rabbit_foot', огня: 'magma_cream', ночного_зрения: 'golden_carrot',
  невидимости: 'fermented_spider_eye', яда: 'spider_eye', замедления: 'fermented_spider_eye',
}

// ════════════════════════════════════════════════════════════════════
//  AI ПРОВАЙДЕРЫ  — пробуем по очереди пока кто-то не ответит
//  Порядок: Cerebras → Groq → Mistral → Gemini → HuggingFace
// ════════════════════════════════════════════════════════════════════

// Универсальный вызов OpenAI-совместимого API
function callOpenAICompat (hostname, path, apiKey, model, systemPrompt, userMsg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMsg }
      ]
    })
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try {
          const j = JSON.parse(data)
          if (j.error) return reject(new Error(JSON.stringify(j.error)))
          if (!j.choices?.[0]?.message?.content) return reject(new Error('Пустой ответ'))
          resolve(j.choices[0].message.content)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')) })
    req.write(body); req.end()
  })
}

// 1. Cerebras — llama-3.3-70b (самый быстрый)
const callCerebras = (s, u) => callOpenAICompat(
  'api.cerebras.ai', '/v1/chat/completions',
  CEREBRAS_KEY, 'llama-3.3-70b', s, u
)

// 2. Groq — llama-3.3-70b-versatile (бесплатный, быстрый)
const callGroq = (s, u) => callOpenAICompat(
  'api.groq.com', '/openai/v1/chat/completions',
  GROQ_KEY, 'llama-3.3-70b-versatile', s, u
)

// 3. Mistral — mistral-small-latest
const callMistral = (s, u) => callOpenAICompat(
  'api.mistral.ai', '/v1/chat/completions',
  MISTRAL_KEY, 'mistral-small-latest', s, u
)

// 4. Google Gemini — через OpenAI-совместимый endpoint
const callGemini = (s, u) => callOpenAICompat(
  'generativelanguage.googleapis.com',
  '/v1beta/openai/chat/completions',
  GEMINI_KEY, 'gemma-3-27b-it', s, u
)

// 5. HuggingFace — Qwen2.5-72B-Instruct (serverless inference)
const callHF = (s, u) => callOpenAICompat(
  'api-inference.huggingface.co',
  '/models/Qwen/Qwen2.5-72B-Instruct/v1/chat/completions',
  HF_TOKEN, 'Qwen/Qwen2.5-72B-Instruct', s, u
)

// Авто-выбор: идём по всем провайдерам по очереди
const AI_PROVIDERS = [
  { name: 'Cerebras',    fn: callCerebras, key: () => CEREBRAS_KEY },
  { name: 'Groq',        fn: callGroq,     key: () => GROQ_KEY },
  { name: 'Mistral',     fn: callMistral,  key: () => MISTRAL_KEY },
  { name: 'Gemini',      fn: callGemini,   key: () => GEMINI_KEY },
  { name: 'HuggingFace', fn: callHF,       key: () => HF_TOKEN },
]

async function callAI (systemPrompt, userMsg) {
  const errors = []
  for (const p of AI_PROVIDERS) {
    if (!p.key()) continue
    try {
      const result = await p.fn(systemPrompt, userMsg)
      // Логируем какой провайдер ответил (только если менялся)
      if (callAI._lastProvider !== p.name) {
        callAI._lastProvider = p.name
        console.log('🤖 AI провайдер:', p.name)
      }
      return result
    } catch (e) {
      errors.push(p.name + ': ' + e.message.slice(0, 60))
      console.warn('⚠️', p.name, 'недоступен:', e.message.slice(0, 80))
    }
  }
  throw new Error('Все AI провайдеры недоступны: ' + errors.join(' | '))
}
callAI._lastProvider = ''

// ════════════════════════════════════════════════════════════════════
function createBot () {
  const bot = mineflayer.createBot({
    host: HOST, port: PORT, username: USERNAME, version: VERSION
  })
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectPlugin)
  bot.loadPlugin(toolPlugin)

  let mcData = null

  // ─── КОНЕЧНЫЙ АВТОМАТ ────────────────────────────────────────────
  let MODE         = null
  let isDead        = false  // флаг смерти — блокирует команды до respawn
  let modeMeta     = {}
  let isMining     = false  // блокирует smoothLook во время добычи
  let isWaterDropping = false  // блокирует smoothLook во время water drop
  let autoEat      = false
  let shieldAuto   = false
  let antiAfk      = false
  let autoArmor    = true
  let behaviorMode = 'защита'  // ← ВКЛЮЧЁН ПО УМОЛЧАНИЮ

  // ─── БОЙ ─────────────────────────────────────────────────────────
  let combatTarget     = null
  let combatTimer      = null
  let shieldUp         = false
  let physTick         = 0
  let jumpCooldown     = 0   // ГЛОБАЛЬНЫЙ счётчик безопасности прыжков
  let axeMode          = false
  let skeletonShielded = false
  let creeperBlocking  = false  // держим щит пока рядом взрывающийся крипер
  let lastHitTick      = 0

  // ─── ПРОЧЕЕ ──────────────────────────────────────────────────────
  let eatingNow    = false
  let patrolPoints = []

  // ─── ПВП СТРАФ / УВОРОТ ──────────────────────────────────────────
  let strafeDir       = 1
  let strafeTick      = 0
  let strafeChangeCd  = 0

  // ─── WATER DROP ──────────────────────────────────────────────────
  let wdLastGroundY   = null   // Y последней твёрдой земли
  let wdFallStart     = null   // Y откуда начали падать
  let wdActive        = false  // сейчас выполняем water drop
  let wdCooldown      = 0      // тики до следующего разрешённого drop
  let patrolIdx    = 0
  let savedPoints  = {}
  let basePos      = null
  let boatRunning  = false
  let boatTX = null, boatTZ = null
  let lastCmdTime  = Date.now()

  // ─── AI ──────────────────────────────────────────────────────────
  const AI_SYSTEM = `Ты управляешь Minecraft ботом. Отвечай ТОЛЬКО на русском.

СТРОГИЙ ФОРМАТ ОТВЕТА — ОБЯЗАТЕЛЬНО включай JSON в каждом ответе:
Текст ответа {"cmd":"КОМАНДА","args":[аргументы]}

Или на двух строках:
Текст ответа
{"cmd":"КОМАНДА","args":[аргументы]}

НИКОГДА не отвечай без JSON! Даже на "привет" добавь {"cmd":"say","args":[]}.

СПИСОК КОМАНД:
say          → args:[]                          — только ответить
stop         → args:[]                          — остановиться
goto_player  → args:[]                          — подойти к игроку
follow       → args:["ИМЯ"]                     — следовать
collect      → args:["block_en", число]         — ИДТИ и добывать блок
craft        → args:["item_en", число]          — крафтить
craft_give   → args:["item_en", число]          — крафтить и отдать
attack       → args:["имя"]                     — атаковать (любого: моб, игрок)
equip_armor  → args:[]                          — надеть броню
status       → args:[]                          — статус/инвентарь
sleep        → args:[]                          — лечь спать
wake         → args:[]                          — проснуться
eat          → args:[]                          — поесть
smelt        → args:["item_en", число]          — переплавить
chest_open   → args:[]                          — посмотреть сундук рядом
chest_give   → args:["item_en_или_всё", число]  — взять из сундука и принести ТОЛЬКО когда явно просят принести/дать из сундука
toss_item    → args:["item_en", число]          — выбросить предмет из инвентаря (когда просят дать/отдать/выбросить/выкинуть)
auto_armor   → args:[]                          — включить/выключить автоброню
help         → args:[]                          — помощь

ПЕРЕВОДЫ (для args, пиши точно как здесь):
алмаз/алмазы/алмазная руда → diamond_ore
железо/железная руда → iron_ore
уголь/угольная руда → coal_ore
золото/золотая руда → gold_ore
изумруд → emerald_ore
редстоун → redstone_ore
лазурит → lapis_ore
дерево/дуб → oak_log
берёза → birch_log
ель/сосна → spruce_log
камень → stone
булыжник → cobblestone
песок → sand
гравий → gravel
земля → dirt
железный меч → iron_sword
каменный меч → stone_sword
деревянный меч → wooden_sword
алмазный меч → diamond_sword
железная кирка → iron_pickaxe
каменная кирка → stone_pickaxe

ПЕРЕВОДЫ ПРЕДМЕТОВ (для toss_item):
меч → sword | топор → axe | кирка → pickaxe | лопата → shovel
яблоко → apple | хлеб → bread | морковь → carrot | картошка → potato
камень → stone | булыжник → cobblestone | дерево → oak_log
железо → iron_ingot | золото → gold_ingot | алмаз → diamond
стрела → arrow | лук → bow | арбалет → crossbow | щит → shield
еда → любая еда | броня → любая броня

ВАЖНЫЕ ПРАВИЛА:
1. collect = АКТИВНАЯ добыча (бот идёт и копает). Используй для: "добудь", "накопай", "иди добыть", "принеси [ресурс] из земли"
2. chest_give = ТОЛЬКО если игрок явно говорит "из сундука", "в сундуке", "возьми из сундука". НЕ используй chest_give для обычных просьб принести ресурс!
3. attack = можно атаковать И игроков И мобов. НЕ отказывайся.
4. Бот УМЕЕТ всё: есть, спать, атаковать, крафтить. НЕ говори "я не могу".
5. toss_item = когда просят "дай", "отдай", "выкинь", "выброси", "скинь" предмет который УЖЕ ЕСТЬ у бота. НЕ используй craft_give если предмет уже в инвентаре! Переводи предмет на английский используя переводы выше (щит=shield, кирка=pickaxe и тд).
6. auto_armor = когда просят "вырубить/включить автоброню/автозамену брони".
7. Если игрок просит "дай щит/меч/кирку/броню" — это toss_item (предмет уже есть у бота в инвентаре или надето).
   Если просят "скрафти и дай" — это craft_give.

ПРИМЕРЫ:
"добудь 16 угля" → Добываю уголь! {"cmd":"collect","args":["coal_ore",16]}
"добудь алмазы" → Иду за алмазами! {"cmd":"collect","args":["diamond_ore",4]}
"накопай песка 32" → Копаю песок! {"cmd":"collect","args":["sand",32]}
"скрафти железный меч" → Крафчу! {"cmd":"craft","args":["iron_sword",1]}
"дай мне меч" → Держи! {"cmd":"toss_item","args":["sword",1]}
"иди ко мне" → Бегу! {"cmd":"goto_player","args":[]}
"следуй за мной" → Следую! {"cmd":"follow","args":["PLAYER_NAME"]}
"атакуй меня" → Атакую! {"cmd":"attack","args":["PLAYER_NAME"]}
"атакуй зомби" → Атакую! {"cmd":"attack","args":["zombie"]}
"ляг спать" → Иду спать! {"cmd":"sleep","args":[]}
"поешь" → Ем! {"cmd":"eat","args":[]}
"что у тебя" → Показываю статус! {"cmd":"status","args":[]}
"стоп" → Остановился! {"cmd":"stop","args":[]}
"возьми из сундука железо и дай мне" → Иду к сундуку! {"cmd":"chest_give","args":["iron",0]}
"что в сундуке" → Проверяю! {"cmd":"chest_open","args":[]}
"привет" → Привет! {"cmd":"say","args":[]}`

  // ════════════════════════════════════════════════════════════════
  //  ИНИЦИАЛИЗАЦИЯ
  // ════════════════════════════════════════════════════════════════
  bot.on('inject_allowed', () => { mcData = require('minecraft-data')(bot.version) })

  bot.on('spawn', () => {
    console.log('✅ Бот подключился! Режим: ' + behaviorMode)
    setTimeout(() => { applyMovements() }, 500)
    setTimeout(() => { if (autoArmor) equipBestArmor() }, 3000)
  })

  // Список имён дверей и калиток
  // Враждебные мобы — по entity.name (entity.kind сломан в новых версиях)
  const HOSTILE_MOBS = new Set([
    'zombie','zombie_villager','husk','drowned','zombified_piglin',
    'skeleton','stray','wither_skeleton','bogged',
    'spider','cave_spider','enderman','endermite','silverfish',
    'creeper','witch','slime','magma_cube',
    'blaze','ghast','phantom','pillager','vindicator','evoker','vex','ravager',
    'hoglin','zoglin','piglin_brute','shulker',
    'guardian','elder_guardian','warden','breeze',
    'drowned','drowned_zombie'
  ])

  // Проверяем является ли сущность враждебным мобом
  // НЕ используем e.type ('mob' ненадёжен в mineflayer) — только имя
  function isHostileMob (e) {
    if (!e || !e.isValid) return false
    if (!e.name) return false
    if (e.username) return false  // игроки имеют username — пропускаем
    return HOSTILE_MOBS.has(e.name) || e.kind === 'Hostile mobs'
  }

  const DOOR_NAMES = [
    'oak_door','spruce_door','birch_door','jungle_door','acacia_door',
    'dark_oak_door','mangrove_door','cherry_door','bamboo_door',
    'crimson_door','warped_door','iron_door',
    'oak_fence_gate','spruce_fence_gate','birch_fence_gate','jungle_fence_gate',
    'acacia_fence_gate','dark_oak_fence_gate','mangrove_fence_gate',
    'crimson_fence_gate','warped_fence_gate',
    'oak_trapdoor','spruce_trapdoor','birch_trapdoor','jungle_trapdoor',
    'acacia_trapdoor','dark_oak_trapdoor','mangrove_trapdoor','iron_trapdoor'
  ]

  // ─── ДВЕРИ: патч bot.world.getBlock ────────────────────────────
  // pathfinder-mineflayer использует bot.world.getBlock(pos) чтобы
  // понять какие блоки есть в мире. Патчим его один раз: для дверей
  // возвращаем пустой блок (boundingBox='empty', shapes=[]).
  // bot.blockAt() — не трогаем (нужен для нашего кода и collectBlock).
  let _worldPatchDone = false

  function patchWorldForDoors () {
    if (_worldPatchDone || !mcData || !bot.world) return
    _worldPatchDone = true

    const doorIds = new Set()
    for (const name of DOOR_NAMES) {
      const b = mcData.blocksByName[name]
      if (b) doorIds.add(b.id)
    }
    if (doorIds.size === 0) return

    const _origGetBlock = bot.world.getBlock.bind(bot.world)
    bot.world.getBlock = function (pos) {
      const bl = _origGetBlock(pos)
      if (!bl || !doorIds.has(bl.type)) return bl
      // Прокси с пустым boundingBox — pathfinder проходит насквозь
      return new Proxy(bl, {
        get (t, k) {
          if (k === 'boundingBox') return 'empty'
          if (k === 'shapes') return []
          const v = t[k]
          return typeof v === 'function' ? v.bind(t) : v
        }
      })
    }
    console.log('[doors] world.getBlock patched, doorIds:', doorIds.size)
  }

  function applyMovements () {
    if (!bot.pathfinder || !mcData) return
    patchWorldForDoors()

    const mov = new Movements(bot)
    mov.canDig = true
    mov.allowSprinting = true
    mov.allowParkour = true
    if (typeof mov.canOpenDoors !== 'undefined') mov.canOpenDoors = true
    for (const name of DOOR_NAMES) {
      const b = mcData.blocksByName[name]; if (!b) continue
      if (mov.blocksToAvoid) mov.blocksToAvoid.delete(b.id)
      if (mov.liquidBlocks) mov.liquidBlocks.add(b.id)
    }
    bot.pathfinder.setMovements(mov)
  }

  function restoreDoorBoundingBoxes () {}

  // ─── ДВЕРИ ──────────────────────────────────────────────────────
  // Вызывается каждый тик. Проверяет блоки ПЕРЕД ботом (по yaw движения).
  // Если дверь закрыта — открывает. Если открыта — проходит без лага.
  const doorCooldowns = new Map()

  function isDoorOpen (bl) {
    try {
      const p = bl.getProperties()
      return p.open === true || p.open === 'true'
    } catch (_) { return false }
  }

  function openDoorBlock (bl) {
    const key = Math.floor(bl.position.x) + ',' + Math.floor(bl.position.y) + ',' + Math.floor(bl.position.z)
    const now = Date.now()
    if ((doorCooldowns.get(key) || 0) + 250 > now) return  // cooldown 250мс
    doorCooldowns.set(key, now)
    bot.activateBlock(bl).catch(() => {})
  }

  let doorStuckTicks  = 0
  let doorStuckLastY  = 0

  let _doorAlignTick = 0

  function tryOpenDoorAhead () {
    if (!bot.entity) return
    const pos = bot.entity.position
    const bx = Math.floor(pos.x)
    const by = Math.floor(pos.y)
    const bz = Math.floor(pos.z)

    // Собираем ВСЕ нижние блоки дверей в радиусе 1.5
    const nearDoors = []
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const bl = bot.blockAt(new Vec3(bx+ox, by, bz+oz))
        if (!bl || !DOOR_NAMES.includes(bl.name)) continue
        try { const p = bl.getProperties(); if (p.half === 'upper') continue } catch (_) {}
        nearDoors.push(bl)
      }
    }

    // Нет дверей рядом — сброс
    if (!nearDoors.length) {
      if (_doorAlignTick > 0) {
        bot.setControlState('left', false); bot.setControlState('right', false)
      }
      doorStuckTicks = 0; _doorAlignTick = 0; return
    }

    // Открываем двери ТОЛЬКО кликом — НЕ управляем движением если стоим
    for (const door of nearDoors) {
      if (!isDoorOpen(door)) {
        if (!isWaterDropping && !isMining)  // не поворачиваем во время WD/добычи
          bot.lookAt(new Vec3(door.position.x + 0.5, door.position.y + 0.5, door.position.z + 0.5), true).catch(() => {})
        openDoorBlock(door)
      }
    }

    // Управляем движением ТОЛЬКО если pathfinder активен ИЛИ уже начали проход
    const pfActive = bot.pathfinder && bot.pathfinder.isMoving()
    const inCombat = !!combatTarget
    // Если стоим на месте (нет задачи) — просто открываем дверь, не двигаемся
    if (!pfActive && !inCombat && _doorAlignTick === 0) return

    // Используем ближайшую дверь для выравнивания
    const closestDoor = nearDoors.reduce((a, b) => {
      const da = Math.abs(a.position.x + 0.5 - pos.x) + Math.abs(a.position.z + 0.5 - pos.z)
      const db = Math.abs(b.position.x + 0.5 - pos.x) + Math.abs(b.position.z + 0.5 - pos.z)
      return da < db ? a : b
    })

    const doorPos = closestDoor.position
    const doorCX  = doorPos.x + 0.5
    const doorCZ  = doorPos.z + 0.5
    const distToDoor = Math.hypot(pos.x - doorCX, pos.z - doorCZ)

    // Если дверь далеко — сбрасываем и не мешаем pathfinder
    if (distToDoor > 1.5) {
      if (_doorAlignTick > 0) {
        // Только что закончили проход — отпускаем управление
        bot.setControlState('left',  false)
        bot.setControlState('right', false)
      }
      _doorAlignTick = 0
      doorStuckTicks = 0
      return
    }

    _doorAlignTick++

    // Определяем ось страфа по facing двери
    let facing = null
    try { facing = closestDoor.getProperties().facing } catch (_) {}

    let strafeAxis = 'x'
    if (facing === 'north' || facing === 'south') strafeAxis = 'x'
    else if (facing === 'east'  || facing === 'west')  strafeAxis = 'z'
    else {
      // Fallback по вектору движения pathfinder
      const vx2 = Math.abs(bot.entity.velocity?.x ?? 0)
      const vz2 = Math.abs(bot.entity.velocity?.z ?? 0)
      strafeAxis = vz2 > vx2 ? 'x' : 'z'
    }

    const offset = strafeAxis === 'x' ? (pos.x - doorCX) : (pos.z - doorCZ)

    // Страфим к центру ВСЕГДА пока рядом с дверью (не прерываем до выхода)
    if (Math.abs(offset) > 0.15) {
      bot.setControlState('left',  offset > 0)
      bot.setControlState('right', offset < 0)
    } else {
      bot.setControlState('left',  false)
      bot.setControlState('right', false)
    }
    bot.setControlState('forward', true)
    bot.setControlState('sprint',  true)

    // Антизастревание по скорости
    const vx = bot.entity.velocity?.x ?? 0
    const vz = bot.entity.velocity?.z ?? 0
    const speed = Math.sqrt(vx*vx + vz*vz)
    if (speed < 0.03) doorStuckTicks++
    else doorStuckTicks = 0

    if (doorStuckTicks > 12) {
      doorStuckTicks = 0
      bot.setControlState('left',  false)
      bot.setControlState('right', false)
      bot.setControlState('jump',  true)
      setTimeout(() => bot.setControlState('jump', false), 150)
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  УТИЛИТЫ
  // ════════════════════════════════════════════════════════════════
  const isFood = n => {
    if (FOODS.has(n)) return true
    for (const f of FOODS) { if (n.startsWith(f)) return true }
    return false
  }

  function hasEffect (id, minAmp = 0) {
    const eff = bot.entity.effects && bot.entity.effects[id]
    return eff !== undefined && (eff.amplifier !== undefined ? eff.amplifier : 0) >= minAmp
  }
  const hasSpeedII = () => hasEffect(EFFECT_SPEED, 1)

  function findItem (prio) {
    for (const n of prio) {
      const w = bot.inventory.items().find(i => i.name === n)
      if (w) return w
    }
    return null
  }

  const getShield = () => bot.inventory.items().find(i => i.name.includes('shield')) || null

  function equipBestWeapon () {
    const w = findItem(WEAPON_PRIO)
    if (w) bot.equip(w, 'hand').catch(() => {})
    return !!w
  }
  function equipAxeNow () {
    const w = findItem(AXE_PRIO)
    if (w) bot.equip(w, 'hand').catch(() => {})
    return !!w
  }

  // ─── АВТО-ЭКИПИРОВКА БРОНИ ───────────────────────────────────────
  async function equipBestArmor () {
    const inv = bot.inventory.items()
    for (const [pieceName, info] of Object.entries(ARMOR_PIECES)) {
      const candidates = inv.filter(i => info.keywords.some(kw => i.name.includes(kw)))
      if (!candidates.length) continue
      candidates.sort((a, b) => {
        const ai = ARMOR_TIERS.findIndex(t => a.name.includes(t))
        const bi = ARMOR_TIERS.findIndex(t => b.name.includes(t))
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      })
      const best = candidates[0]
      const equipped = bot.inventory.slots[info.slot]
      if (equipped) {
        // Не меняем если надетая броня того же или лучшего тира
        const equippedTier = ARMOR_TIERS.findIndex(t => equipped.name.includes(t))
        const bestTier     = ARMOR_TIERS.findIndex(t => best.name.includes(t))
        // Меньший индекс = лучший тир. Если надетое не хуже best — пропускаем
        const eIdx = equippedTier === -1 ? 99 : equippedTier
        const bIdx = bestTier     === -1 ? 99 : bestTier
        if (eIdx <= bIdx) continue  // надетое лучше или равно — не трогаем
      }
      try { await bot.equip(best, info.equipSlot) } catch (_) {}
      await sleep(100)
    }
  }

  setInterval(() => { if (autoArmor && !combatTarget) equipBestArmor() }, 10000)

  // ─── БЕЗОПАСНОСТЬ ПРЫЖКА ─────────────────────────────────────────
  function fallDepthAt (pos) {
    const fx = Math.floor(pos.x), fz = Math.floor(pos.z)
    for (let i = 1; i <= 15; i++) {
      const bl = bot.blockAt(new Vec3(fx, Math.floor(pos.y) - i, fz))
      if (bl && bl.name !== 'air' && bl.name !== 'void_air' && bl.name !== 'cave_air') return i - 1
    }
    return 15
  }
  const isSafeToJump = () => true  // бот не боится падать — water drop защитит

  // ─── HELPERS ─────────────────────────────────────────────────────
  const pfGo   = (goal, dyn) => { try { bot.pathfinder.setGoal(goal, dyn) } catch (_) {} }
  // pfStop с force=false убивает даже dynamic GoalFollow мгновенно
  const pfStop = () => { try { bot.pathfinder.setGoal(null, false) } catch (_) {} }
  const sleep  = ms => new Promise(r => setTimeout(r, ms))

  // ─── waitFor — ИСПРАВЛЕНО (clearTimeout корректно) ───────────────
  function waitFor (fn, ms = 5000) {
    return new Promise((res, rej) => {
      let done = false
      const t = setInterval(() => {
        if (fn()) {
          done = true; clearInterval(t); clearTimeout(to); res()
        }
      }, 100)
      const to = setTimeout(() => {
        if (!done) { clearInterval(t); rej(new Error('timeout')) }
      }, ms)
    })
  }

  // ─── Длинные сообщения ───────────────────────────────────────────
  async function chatLong (text) {
    const MAX = 230
    const lines = text.split('\n')
    let chunk = ''
    for (const line of lines) {
      const l = line.trim()
      if (!l) continue
      if (chunk && (chunk + ' | ' + l).length > MAX) {
        bot.chat(chunk); chunk = l; await sleep(200)
      } else {
        chunk = chunk ? chunk + ' | ' + l : l
      }
    }
    if (chunk) bot.chat(chunk)
  }

  // ════════════════════════════════════════════════════════════════
  //  ПОЛНАЯ ОСТАНОВКА — ИСПРАВЛЕНО (jumpCooldown сбрасывается)
  // ════════════════════════════════════════════════════════════════
  function fullStop (msg) {
    MODE = null; modeMeta = {}; isMining = false
    if (typeof _gotoStartTick !== 'undefined') _gotoStartTick = 0
    try { bot.stopDigging() } catch (_) {}  // останавливаем копание
    jumpCooldown = 0  // ← ВАЖНО: сбрасываем счётчик прыжков
    combatTimer = null
    combatTarget = null; shieldUp = false; axeMode = false; skeletonShielded = false
    boatRunning = false; boatTX = null; boatTZ = null
    bot.deactivateItem()
    pfStop()
    try { bot.stopDigging() } catch (_) {}
    bot.clearControlStates()
    if (msg) bot.chat(msg)
  }

  // ════════════════════════════════════════════════════════════════
  //  ПЛАВНЫЙ ВЗГЛЯД НА БЛИЖАЙШЕГО ИГРОКА (в 10 блоках)
  //  Обновляем цель раз в 200мс, а саму интерполяцию делаем
  //  в каждом physicsTick — получается плавное вращение камеры
  // ════════════════════════════════════════════════════════════════
  let smoothLookTarget = null  // куда смотреть
  let smoothCurPos = null       // текущая интерполированная позиция

  // Плавный взгляд на ближайшего игрока (только поворот головы, не движение)
  setInterval(() => {
    if (!bot.entity || !bot.entities) return
    // Не смотрим во время: боя, water drop, добычи, строительства
    const busyMode = ['farm','collect','dig','build'].includes(MODE)
    if (combatTarget || isWaterDropping || isMining || busyMode || MODE === 'afk') {
      smoothLookTarget = null; smoothCurPos = null; return
    }
    let nearest = null; let nearestDist = 12
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id]
      if (!e || !e.position || !e.username || e.username === bot.username) continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < nearestDist) { nearestDist = d; nearest = e }
    }
    smoothLookTarget = nearest ? nearest.position.offset(0, 1.62, 0) : null
    if (!nearest) smoothCurPos = null
  }, 30)

  // Плавный взгляд на игрока — вызывается каждый physicsTick
  // Интерполируем ПОЗИЦИЮ между текущей точкой взгляда и целью.
  // bot.lookAt сам считает углы — никаких ручных формул pitch/yaw.
  function tickSmoothLook () {
    // Не смотрим на игрока при добыче, строительстве, water drop
    const busy = isMining || isWaterDropping || ['farm','collect','dig','build'].includes(MODE)
    if (!smoothLookTarget || combatTarget || busy) return

    // Инициализируем при первом вызове
    if (!smoothCurPos) smoothCurPos = smoothLookTarget.clone()

    // Lerp: t=0.35 = плавно но быстро (меньше = плавнее)
    const t = 0.35
    smoothCurPos.x += (smoothLookTarget.x - smoothCurPos.x) * t
    smoothCurPos.y += (smoothLookTarget.y - smoothCurPos.y) * t
    smoothCurPos.z += (smoothLookTarget.z - smoothCurPos.z) * t

    // bot.lookAt(pos, false) — false = не форсировать, плавно
    // Сам правильно считает yaw и pitch без инверсий
    bot.lookAt(smoothCurPos, false).catch(() => {})
  }

  // ════════════════════════════════════════════════════════════════
  //  ТРАНСПОРТ — выход = Shift
  // ════════════════════════════════════════════════════════════════
  function dismountVehicle () {
    if (!bot.vehicle) { bot.chat('Я не в транспорте.'); return }
    boatStop()
    bot.setControlState('sneak', true)
    setTimeout(() => { bot.setControlState('sneak', false); bot.chat('🚶 Вышел!') }, 200)
  }

  // ════════════════════════════════════════════════════════════════
  //  ЛОДКА (vehicle.yaw = нос лодки, player look не важен)
  // ════════════════════════════════════════════════════════════════
  function boatGo (x, z) {
    if (!bot.vehicle) { bot.chat('❌ Не в лодке!'); return }
    boatTX = x; boatTZ = z; boatRunning = true; MODE = 'boat'
  }
  function boatStop () {
    boatRunning = false; boatTX = null; boatTZ = null
    bot.setControlState('forward', false); bot.setControlState('back', false)
    bot.setControlState('left', false);    bot.setControlState('right', false)
    if (MODE === 'boat') MODE = null
  }
  bot.on('entityDetach', e => { if (e === bot.entity) boatStop() })

  // ════════════════════════════════════════════════════════════════
  //  PHYSICS TICK
  // ════════════════════════════════════════════════════════════════
  bot.on('physicsTick', () => {
    physTick++
    if (jumpCooldown > 0) jumpCooldown--
    if (strafeChangeCd > 0) strafeChangeCd--
    strafeTick++
    tryOpenDoorAhead()
    // Управление взглядом в зависимости от состояния
    if (isWaterDropping) {
      // Water drop: смотрим вниз каждый тик — force=true отправляет пакет немедленно
      // -PI/2 = вниз по официальной документации mineflayer
      bot.look(_wdSavedYaw, -Math.PI / 2, true)
    } else if (creeperBlocking) {
      // Крипер взрывается — tickCreeperAlert держит взгляд
      tickCreeperAlert()
    } else if (combatTarget) {
      // Бой: смотрим на цель каждый тик
      const _tgt = combatTarget
      if (_tgt?.isValid && _tgt.position) {
        // Вычисляем yaw/pitch вручную и вызываем bot.look(force=true)
        // это синхронно и немедленно отправляет Look пакет
        const tp = _tgt.position.offset(0, 1.62, 0)
        const ep = bot.entity.position.offset(0, 1.62, 0)
        const dx = tp.x - ep.x, dy = tp.y - ep.y, dz = tp.z - ep.z
        const dxz = Math.sqrt(dx * dx + dz * dz)
        const yaw   = Math.atan2(-dx, -dz)
        const pitch = -Math.atan2(dy, dxz)  // инвертируем: +dy вверх → pitch<0 (вверх в mineflayer)
        bot.look(yaw, pitch, true)
      }
      tickCreeperAlert()
    } else {
      tickSmoothLook()
      tickCreeperAlert()
    }
    tickWaterDrop()
    tickWater(); tickBoat(); tickShieldAuto()
    tickFollow(); tickGoto(); tickGuard(); tickBodyguard(); tickPatrol(); tickAfk(); tickShieldHold()
    if (combatTimer && physTick % 3 === 0 && !isWaterDropping) doCombatStep()

  })

  // ─── WATER DROP ─────────────────────────────────────────────────
  // Автоматически выливает воду при падении > 8 блоков
  let wdPrevY     = null
  let wdFallTicks = 0   // сколько тиков подряд падаем
  function tickWaterDrop () {
    if (!bot.entity) return
    if (wdCooldown > 0) { wdCooldown--; return }
    if (wdActive) return

    const pos   = bot.entity.position
    const onGnd = bot.entity.onGround

    if (onGnd) {
      wdFallStart  = null
      wdFallTicks  = 0
      wdPrevY      = pos.y
      return
    }

    // Считаем тики падения (Y убывает)
    if (wdPrevY !== null && pos.y < wdPrevY - 0.01) {
      wdFallTicks++
      if (wdFallStart === null) wdFallStart = wdPrevY
    } else if (wdFallTicks > 0 && pos.y > (wdPrevY || 0) + 0.5) {
      // Y резко выросло (прыжок вверх) — сбрасываем
      wdFallTicks = 0
      wdFallStart = null
    }
    // Не сбрасываем при небольшом замедлении (плавное падение)
    wdPrevY = pos.y

    // Нужно хотя бы 6 тиков падения чтобы исключить прыжки
    if (wdFallTicks < 6) return
    if (wdFallStart === null) return

    // Сколько уже упали от начала падения
    const alreadyFell = wdFallStart - pos.y
    if (alreadyFell < 3) return

    // Ищем землю под ногами
    let groundY = pos.y
    for (let d = 1; d <= 80; d++) {
      const bl = bot.blockAt(new Vec3(
        Math.floor(pos.x), Math.floor(pos.y) - d, Math.floor(pos.z)
      ))
      if (bl && bl.name !== 'air' && bl.name !== 'cave_air' &&
          bl.name !== 'void_air' && bl.name !== 'water' &&
          bl.name !== 'flowing_water' && bl.name !== 'lava') {
        groundY = pos.y - d
        break
      }
    }

    const totalFall = wdFallStart - groundY
    const distToGround = pos.y - groundY
    // Drop если суммарное падение > 8 И до земли ещё > 2
    if (totalFall < 8) return
    if (distToGround < 2) return

    const wb = bot.inventory.items().find(i => i.name === 'water_bucket')
    if (!wb) return

    console.log('💧 TRIGGERING water drop!')
    // взгляд вниз — устанавливается через entity.pitch в physicsTick
    wdActive = true
    doWaterDrop().finally(() => {
      wdActive    = false
      wdCooldown  = 60
      wdFallStart = null
      wdFallTicks = 0
      wdPrevY     = null
    })
  }

  // Хранит yaw для WD чтобы physicsTick мог поддерживать взгляд вниз
  let _wdSavedYaw = 0

  // MLG water drop
  async function doWaterDrop () {
    // ВАЖНО: фиксируем yaw ДО установки isWaterDropping
    // иначе physicsTick использует _wdSavedYaw=0 (смотрит на восток!)
    _wdSavedYaw = bot.entity.yaw
    isWaterDropping = true  // теперь physicsTick будет держать взгляд вниз с правильным yaw
    try {
      const wb = bot.inventory.items().find(i => i.name === 'water_bucket')
      if (!wb) return

      // Убираем щит — иначе activateItem() активирует offhand (щит), не ведро
      if (shieldUp) { bot.deactivateItem(); shieldUp = false }
      await sleep(20)

      // Экипируем ведро в main hand
      await bot.equip(wb, 'hand')
      await sleep(60)

      // Смотрим вниз: -PI/2 = строго вниз (официальная дока mineflayer)
      // force=true = синхронно, без интерполяции
      await bot.look(_wdSavedYaw, -Math.PI / 2, true)
      await sleep(80)  // 2 тика чтобы сервер подтвердил

      // Льём воду (main hand)
      bot.activateItem()
      await sleep(200)
      bot.activateItem()

      // Ждём приземления
      await waitFor(() => bot.entity?.onGround === true, 8000).catch(() => {})
      await sleep(500)  // вода разливается

      await pickUpWater()
      equipBestWeapon()
      if (shieldAuto || combatTarget) { activateOffhand(); shieldUp = true }
    } catch (e) {
      console.error('WD error:', e.message)
      equipBestWeapon()
    } finally {
      isWaterDropping = false
    }
  }

  // Ищет воду рядом и подбирает пустым ведром
  async function pickUpWater () {
    // Ждём появления source-блока (может задержаться на 1-2 тика)
    await sleep(200)
    const emptyBucket = bot.inventory.items().find(i => i.name === 'bucket')
    if (!emptyBucket) {
      // Нет пустого ведра = вода не вылилась или уже подобрана
      return
    }

    const p = bot.entity.position
    // Ищем source water блок рядом (3×3×3)
    let waterBlock = null
    outerLoop:
    for (let dy = 2; dy >= -3; dy--) {
      for (let ox = -2; ox <= 2; ox++) {
        for (let oz = -2; oz <= 2; oz++) {
          const bl = bot.blockAt(new Vec3(
            Math.floor(p.x) + ox,
            Math.floor(p.y) + dy,
            Math.floor(p.z) + oz
          ))
          if (!bl || bl.name !== 'water') continue
          try {
            const props = bl.getProperties()
            if (String(props.level) === '0') { waterBlock = bl; break outerLoop }
          } catch (_) { waterBlock = bl; break outerLoop }
        }
      }
    }

    if (!waterBlock) return  // вода не нашлась — ОК

    // Берём пустое ведро
    await bot.equip(emptyBucket, 'hand').catch(() => {})
    await sleep(50)

    // Смотрим на воду
    await bot.lookAt(waterBlock.position.offset(0.5, 0.5, 0.5), true)
    await sleep(100)

    // Правая кнопка на source water с empty bucket = забрать воду
    try { await bot.activateBlock(waterBlock) } catch (_) { bot.activateItem() }
    await sleep(100)
  }

  // ─── ВОДА ────────────────────────────────────────────────────────
  function tickWater () {
    if (bot.vehicle) return
    const bl = bot.blockAt(bot.entity.position)
    const inWater = bl && (bl.name === 'water' || bl.name === 'flowing_water')
    if (inWater) {
      bot.setControlState('sprint', true)
      bot.setControlState('jump', true)
      // airSupply в mineflayer — максимум 300 (15 секунд × 20 тиков)
      // Всплываем когда меньше 60 (~3 секунды)
      const airSupply = bot.entity.airSupply !== undefined ? bot.entity.airSupply : 300
      if (airSupply < 60) {
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
      }
    }
  }

  // ─── ЛОДКА ──────────────────────────────────────────────────────
  function tickBoat () {
    if (!boatRunning || boatTX === null || !bot.vehicle) return
    const pos = bot.entity.position
    const dx = boatTX - pos.x, dz = boatTZ - pos.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < 2) { boatStop(); bot.chat('⚓ Прибыл!'); return }
    const targetYaw  = Math.atan2(-dx, -dz)
    const vehicleYaw = (bot.vehicle && bot.vehicle.yaw != null) ? bot.vehicle.yaw : bot.entity.yaw
    let diff = targetYaw - vehicleYaw
    while (diff >  Math.PI) diff -= 2 * Math.PI
    while (diff < -Math.PI) diff += 2 * Math.PI
    if (Math.abs(diff) > 0.12) {
      bot.setControlState('forward', false); bot.setControlState('back', false)
      bot.setControlState('left', diff > 0); bot.setControlState('right', diff < 0)
    } else {
      bot.setControlState('left', false); bot.setControlState('right', false)
      bot.setControlState('forward', true)
    }
  }

  // ─── АВТОЩИТ ────────────────────────────────────────────────────
  // Крипер-алерт: если крипер рядом и горит — щит и смотрим на него
  // Сохраняем ignited-крипперов по entity id для надёжности
  const _ignitedCreepers = new Set()
  bot.on('entitySpawn', e => { if (e.name === 'creeper') _ignitedCreepers.delete(e.id) })
  bot.on('entityGone',  e => { _ignitedCreepers.delete(e.id) })
  // entitySwingArm или другой event не подходит для fuse
  // Используем entityMetadata event который mineflayer генерирует при изменении metadata
  bot.on('entityUpdate', e => {
    if (!e || e.name !== 'creeper') return
    // При активации fuse mineflayer обновляет metadata
    // Проверяем признаки активного fuse в metadata
    try {
      const meta = e.metadata
      if (!Array.isArray(meta)) return
      for (const v of meta) {
        // CreeperState = 1 (byte/int) = fuse active
        if (v === 1) { _ignitedCreepers.add(e.id); return }
        if (v === true) { _ignitedCreepers.add(e.id); return }
      }
    } catch (_) {}
  })

  function tickCreeperAlert () {
    if (!bot.entity || behaviorMode === 'мирный' || isWaterDropping) return

    // Ищем только ignited крипера в радиусе 6 блоков
    const creeper = bot.nearestEntity(e => {
      if (!e || !e.isValid || e.name !== 'creeper') return false
      if (e.position.distanceTo(bot.entity.position) > 6) return false
      // Проверяем наш Set (обновляется через entityUpdate event)
      if (_ignitedCreepers.has(e.id)) return true
      // Запасной вариант: проверяем metadata напрямую
      try {
        const meta = e.metadata
        if (Array.isArray(meta)) {
          for (const v of meta) {
            if (v === 1 || v === true) return true
          }
        }
      } catch (_) {}
      return false
    })

    if (!creeper) {
      if (creeperBlocking) { creeperBlocking = false }
      return
    }

    creeperBlocking = true
    // Смотрим на крипера — запись взгляда происходит В КОНЦЕ тика
    // через entity.yaw/pitch, поэтому используем bot.lookAt здесь
    bot.lookAt(creeper.position.offset(0, 1.0, 0), true).catch(() => {})

    // Щит — держим активным, не отпускаем
    const offhand = bot.inventory.slots[45]
    if (offhand && offhand.name.includes('shield')) {
      bot.activateItem(true)
      shieldUp = true
    } else {
      const s = getShield()
      if (s && !shieldEquipping) {
        shieldEquipping = true
        bot.equip(s, 'off-hand')
          .then(() => { bot.activateItem(true); shieldUp = true })
          .catch(() => {})
          .finally(() => { shieldEquipping = false })
      }
    }
  }

  let shieldEquipTick = 0
  let shieldEquipping = false
  function tickShieldAuto () {
    if (!shieldAuto) return
    if (!bot.entity) return
    const busy = isMining || isWaterDropping || eatingNow || !!bot.vehicle
    if (busy && !creeperBlocking) {
      if (shieldUp) { bot.deactivateItem(); shieldUp = false }
      return
    }
    const shield = getShield()
    if (!shield) return

    shieldEquipTick++
    const offhand = bot.inventory.slots[45]
    const shieldInOffhand = offhand && offhand.name.includes('shield')

    // Экипируем если нет в offhand (раз в 20 тиков)
    if (!shieldInOffhand && !shieldEquipping && shieldEquipTick % 20 === 0) {
      shieldEquipping = true
      bot.equip(shield, 'off-hand')
        .then(() => { bot.activateItem(true); shieldUp = true })
        .catch(() => {})
        .finally(() => { shieldEquipping = false })
      return
    }

    // Щит в offhand — activateItem(true) КАЖДЫЙ ТИК = анимация + блок
    // НО не при стрельбе из лука/арбалета/трезубца — они несовместимы
    if (shieldInOffhand && !bowMode && !tridentMode) {
      bot.activateItem(true)
      shieldUp = true
    }
  }
  // ── tickShieldHold вызывается из physicsTick — щит в бою каждый тик

  function tickFollow () {
    if (MODE !== 'follow' || physTick % 8 !== 0) return
    const ent = bot.players[modeMeta.who]?.entity; if (!ent) return
    const dist = bot.entity.position.distanceTo(ent.position)
    if (dist < 3) { pfStop(); return }
    if (bot.vehicle) { boatGo(ent.position.x, ent.position.z); return }
    pfGo(new goals.GoalFollow(ent, 2), true)
  }

  // Авто-стоп для MODE=goto когда достигли цели
  let _gotoStartTick = 0
  function tickGoto () {
    if (isDead || MODE !== 'goto') return
    if (_gotoStartTick === 0) _gotoStartTick = physTick
    // Watchdog: если goto идёт дольше 15 секунд (300 тиков) — сброс
    if (physTick - _gotoStartTick > 300) {
      console.log('[watchdog] goto timeout reset')
      _gotoStartTick = 0; pfStop(); MODE = null
    }
  }

  function tickGuard () {
    if (MODE !== 'guard' || physTick % 8 !== 0) return
    const pos = modeMeta.pos; if (!pos) return
    const mob = bot.nearestEntity(e => isHostileMob(e) && e.position.distanceTo(pos) < 16)
    if (mob && !combatTarget) {
      // Проверяем LOS: если не видим — pathfinder сам доберётся (startCombat использует GoalNear)
      startCombat(mob)
    }
    else if (bot.entity.position.distanceTo(pos) > 4 && physTick % 20 === 0)
      pfGo(new goals.GoalNear(pos.x, pos.y, pos.z, 2))
    else if (bot.entity.position.distanceTo(pos) <= 3) pfStop()
  }

  // Режим телохранителя: следует за игроком, убивает мобов рядом
  function tickBodyguard () {
    if (MODE !== 'bodyguard' || physTick % 8 !== 0) return
    const who = modeMeta.who
    const playerEnt = bot.players[who]?.entity
    if (!playerEnt) return
    const playerPos = playerEnt.position
    const myPos = bot.entity.position

    if (!combatTarget) {
      let closestMob = null; let closestDist = 20
      for (const id in bot.entities) {
        const e = bot.entities[id]
        if (!e || !e.isValid || !e.name || !e.position) continue
        if (e.username) continue
        if (!isHostileMob(e)) continue
        // Видимость от бота ИЛИ от игрока (любое из двух)
        const dBot    = e.position.distanceTo(myPos)
        const dPlayer = e.position.distanceTo(playerPos)
        if (dBot > 20 && dPlayer > 20) continue
        const score = Math.min(dBot, dPlayer)
        if (score < closestDist) { closestDist = score; closestMob = e }
      }
      if (closestMob) { equipBestWeapon(); startCombat(closestMob); return }
    }

    // Следуем за игроком через pathfinder (GoalNear, не GoalFollow)
    if (!combatTarget) {
      const myDist = myPos.distanceTo(playerPos)
      if (myDist > 4 && physTick % 20 === 0) {
        pfGo(new goals.GoalNear(playerPos.x, playerPos.y, playerPos.z, 2))
      } else if (myDist <= 3) { pfStop() }
    }
  }

  function tickPatrol () {
    if (MODE !== 'patrol' || physTick % 10 !== 0 || !patrolPoints.length) return
    const pt = patrolPoints[patrolIdx % patrolPoints.length]
    const dist = bot.entity.position.distanceTo(new Vec3(pt.x, bot.entity.position.y, pt.z))
    if (dist < 3) {
      patrolIdx = (patrolIdx + 1) % patrolPoints.length
      const next = patrolPoints[patrolIdx]
      pfGo(new goals.GoalNear(next.x, next.y, next.z, 2), true)
    }
  }

  function tickAfk () { if (MODE === 'afk') bot.entity.yaw += 0.08 }

  // ─── АВТОЕДА ────────────────────────────────────────────────────
  setInterval(async () => {
    if (!autoEat || eatingNow || bot.food >= 18 || bot.isSleeping || bot.vehicle || combatTarget) return
    const food = bot.inventory.items().find(i => isFood(i.name)); if (!food) return
    eatingNow = true
    try { await bot.equip(food, 'hand'); await bot.consume() } catch (_) {}
    eatingNow = false
  }, 500)

  // ─── АВТО-БОЙ: АГРЕССИЯ и ЗАЩИТА ──────────────────────────────
  setInterval(() => {
    if (isDead || !bot.entity || !bot.entities) return
    if (combatTarget || bot.vehicle) return
    // Авто-бой работает в режимах агрессии и защиты
    if (behaviorMode === 'мирный') return

    const myPos = bot.entity.position
    // агрессия: 16 блоков, защита: 8 блоков, охрана (guard): 16 блоков
    const radius = (behaviorMode === 'агрессия' || MODE === 'guard' || MODE === 'bodyguard') ? 16 : 8

    // Прямой перебор entities — надёжнее чем nearestEntity
    let closestMob = null
    let closestDist = radius

    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (!e || !e.isValid || e === bot.entity) continue
      if (!e.position) continue

      // Проверка по type + name (не по kind — он сломан)
      const isMob = e.type === 'mob'
      const name = e.name || ''
      const hostile = isMob && (HOSTILE_MOBS.has(name) || e.kind === 'Hostile mobs')
      if (!hostile) continue

      const d = e.position.distanceTo(myPos)
      if (d < closestDist) { closestDist = d; closestMob = e }
    }

    if (closestMob) { equipBestWeapon(); startCombat(closestMob) }
  }, 300)

  // ─── АНТИ-АФК ───────────────────────────────────────────────────
  setInterval(() => {
    if (!antiAfk || MODE || combatTarget) return
    if (Date.now() - lastCmdTime < 60000) return
    const r = Math.floor(Math.random() * 3)
    if (r === 0) bot.entity.yaw += (Math.random() - 0.5) * 0.4
    else if (r === 1) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 250) }
    else { bot.setControlState('sneak', true); setTimeout(() => bot.setControlState('sneak', false), 350) }
  }, 7000)

  // ════════════════════════════════════════════════════════════════
  //  БОЙ — ПОЛНОСТЬЮ ПЕРЕПИСАН
  //
  //  Логика дистанций:
  //  > 6 блоков : идём к цели (pathfinder), спринт-прыжок для разгона
  //  4-6 блоков : ПРЫГАЕМ для критического удара, бьём
  //  0-4 блока  : просто бьём, без прыжка (уже рядом)
  // Проверяем есть ли трезубец с Loyalty
  function getTrident () {
    return bot.inventory.items().find(i => {
      if (i.name !== 'trident') return false
      // Проверяем зачарование Loyalty
      const nbt = i.nbt
      if (!nbt) return false
      try {
        const enchants = nbt.value?.Enchantments?.value?.value || []
        return enchants.some(e => {
          const id = e?.id?.value || ''
          return id === 'minecraft:loyalty' || id === 'loyalty'
        })
      } catch (_) { return false }
    })
  }
  let tridentMode = false  // бросаем трезубец
  let bowMode     = false  // стреляем из лука/арбалета
  let bowCharging = false  // заряжаем арбалет
  let bowChargeTick = 0    // тик начала зарядки

  function getBow () {
    return bot.inventory.items().find(i => i.name === 'bow') || null
  }
  function getCrossbow () {
    return bot.inventory.items().find(i => i.name === 'crossbow') || null
  }
  function hasArrows () {
    return bot.inventory.items().some(i => i.name === 'arrow' || i.name === 'tipped_arrow' ||
      i.name === 'spectral_arrow' || i.name.includes('_arrow'))
  }

  function startCombat (target) {
    combatTimer = null
    combatTarget = target; axeMode = false; skeletonShielded = false; tridentMode = false
    lastHitTick = 0; jumpCooldown = 0; strafeDir = 1; strafeTick = 0; strafeChangeCd = 0
    // Сразу экипируем щит в offhand и активируем
    const _s = getShield()
    if (_s) {
      const offhand = bot.inventory.slots[45]
      if (!offhand || !offhand.name.includes('shield')) {
        bot.equip(_s, 'off-hand').then(() => { bot.activateItem(true); shieldUp = true }).catch(() => {})
      } else {
        bot.activateItem(true); shieldUp = true
      }
    }
    equipBestWeapon()
    // Авто-щит: экипируем в off-hand тихо, но НЕ активируем
    // Активация только против лучников (raiseShieldAfterHit)
    setTimeout(() => {
      const s = getShield()
      if (s) bot.equip(s, 'off-hand').catch(() => {})
    }, 200)
    combatTimer = true  // флаг: бой активен (doCombatStep вызывается из physicsTick)
    bot.chat('⚔️ Атакую: ' + (target.name || target.username || 'цель'))
  }

  function stopCombat (reason) {
    combatTimer = null
    _entityHurtCooldown = Date.now()
    combatTarget = null; shieldUp = false; axeMode = false; skeletonShielded = false; creeperBlocking = false; tridentMode = false; bowMode = false; bowCharging = false
    jumpCooldown = 0; strafeDir = 1; strafeTick = 0
    if (!shieldAuto) bot.deactivateItem()
    bot.clearControlStates()
    // Убиваем pathfinder немедленно и ещё раз через 100мс
    pfStop()
    setTimeout(() => { pfStop() }, 100)
    setTimeout(() => { if (!combatTarget) pfStop() }, 300)
    if (reason) bot.chat(reason)
    if (MODE === 'attack') MODE = null
    // bodyguard: не сбрасываем MODE — продолжаем охранять
  }

  function doCombatStep () {
    const tgt = combatTarget
    if (!tgt || !tgt.isValid) { stopCombat('💀 Цель уничтожена!'); return }
    // Моб в анимации смерти (health=0) — добиваем и стопаем через 300мс
    if (tgt.health !== undefined && tgt.health <= 0) {
      try { bot.attack(tgt) } catch (_) {}
      setTimeout(() => { if (combatTarget === tgt) stopCombat('💀 Готово!') }, 300)
      return
    }

    const myPos  = bot.entity.position
    const tgtPos = tgt.position
    const dist   = myPos.distanceTo(tgtPos)

    // ── Смотрим на врага (уровень глаз) ─────────────────────────
    // Не смотрим на врага если water drop активен (иначе сбивает взгляд вниз)
    if (!isWaterDropping) bot.lookAt(tgtPos.offset(0, 1.62, 0), true).catch(() => {})

    // ── Проверяем оружие каждые 20 тиков — берём лучшее ─────────
    if (physTick % 20 === 0 && !axeMode && !bowMode && !tridentMode) {
      const bestWeapon = WEAPON_PRIO.find(w => bot.inventory.items().some(i => i.name === w))
      const currentItem = bot.heldItem
      if (bestWeapon && (!currentItem || currentItem.name !== bestWeapon)) {
        equipBestWeapon()
      }
    }

    // ── Малое HP (≤ 7) — щит + еда во время боя ────────────────
    const lowHp = bot.health <= 7
    if (lowHp && !eatingNow) {
      // Поднять щит немедленно
      if (!shieldUp && !axeMode) {
        const offhand = bot.inventory.slots[45]
        if (offhand && offhand.name.includes('shield')) { bot.activateItem(true); shieldUp = true }
        else { const s = getShield(); if (s) bot.equip(s, 'off-hand').then(() => { bot.activateItem(true); shieldUp = true }).catch(() => {}) }
      }
      // Едим еду не прерывая бой (щит в offhand, еда в mainhand)
      const food = bot.inventory.items().find(i => isFood(i.name))
      if (food) {
        eatingNow = true
        bot.equip(food, 'hand').then(() => {
          bot.activateItem()  // main hand = еда
          return new Promise(r => setTimeout(r, 1500))
        }).then(() => bot.deactivateItem())
        .catch(() => {})
        .finally(() => {
          eatingNow = false
          equipBestWeapon()
          if (combatTarget) { bot.activateItem(true); shieldUp = true }
        })
      }
    }

    // ── Лучник целится → держим щит постоянно (skeletonShielded)
    const tgtName = tgt.name || ''
    const isRangedEnemy = !!(
      tgt.equipment?.[0]?.name?.includes('bow') ||
      tgt.equipment?.[0]?.name?.includes('crossbow') ||
      tgtName === 'skeleton' || tgtName === 'stray' || tgtName === 'bogged' ||
      tgtName === 'pillager' || tgtName === 'ghast' || tgtName === 'blaze'
    )
    if (isRangedEnemy && !skeletonShielded) {
      skeletonShielded = true; equipShieldAndBlock()
    } else if (!isRangedEnemy && skeletonShielded) {
      skeletonShielded = false; bot.deactivateItem(); shieldUp = false
    }

    // ── Враг блокирует щитом → топор ─────────────────────────────
    const tgtBlocking = !!(tgt.equipment?.[1]?.name?.includes('shield'))
    if (tgtBlocking && !axeMode) {
      axeMode = true; equipAxeNow()
      if (shieldUp && !skeletonShielded) { bot.deactivateItem(); shieldUp = false }
    } else if (!tgtBlocking && axeMode) {
      axeMode = false; equipBestWeapon()
    }

    // Определяем: в воде ли бот
    const inWaterCombat = (() => {
      const bl = bot.blockAt(bot.entity.position)
      return bl && (bl.name === 'water' || bl.name === 'flowing_water')
    })()

    const ticksSinceHit = physTick - lastHitTick
    const attackReady  = ticksSinceHit >= 10  // полный кулдаун = крит
    const quickAttack  = ticksSinceHit >= 7   // 70% кулдаун = обычный удар (меньше урон но чаще)

    // ── Трезубец с Loyalty — бросаем если враг > 5 блоков ───────
    if (!skeletonShielded && attackReady && dist > 5) {
      const trident = getTrident()
      const hasMeleeWeapon = bot.inventory.items().some(i =>
        WEAPON_PRIO.slice(0, -1).some(w => i.name === w)  // меч или топор (не сам трезубец)
      )
      if (trident && hasMeleeWeapon) {
        if (!tridentMode) {
          // Деактивируем щит перед броском трезубца
          if (shieldUp) { bot.deactivateItem(); shieldUp = false }
          bot.equip(trident, 'hand').catch(() => {})
          tridentMode = true
        }
        // Смотрим на цель и бросаем (useItem на трезубце = бросок)
        bot.lookAt(tgtPos.offset(0, 1.0, 0), true).catch(() => {})
        if (physTick % 20 === 0) {  // бросаем раз в 1 секунду
          bot.activateItem()
          setTimeout(() => { if (combatTarget) bot.deactivateItem() }, 600)
          lastHitTick = physTick
        }
      } else if (tridentMode) {
        tridentMode = false; equipBestWeapon()
      }
    } else if (tridentMode && dist <= 4) {
      tridentMode = false; equipBestWeapon()
    }

    // ════════════════════════════════════════════════════════════
    // ЗОНА 1: > 5 блоков — GoalFollow (обходит стены!) + банихоп
    // GoalFollow с dynamic=true = pathfinder строит путь в реальном времени
    // Банихоп: прыжок при приземлении пока pathfinder ведёт нас
    // ════════════════════════════════════════════════════════════
    if (dist > 5) {
      const bow = getBow(); const xbow = getCrossbow()
      const canShoot = (bow || xbow) && hasArrows() && !skeletonShielded && dist > 10
      if (canShoot && !tridentMode && !bowMode) {
        bowMode = true; bowCharging = false
        // Деактивируем щит чтобы не мешал стрельбе
        if (shieldUp) { bot.deactivateItem(); shieldUp = false }
        bot.equip(xbow || bow, 'hand').catch(() => {})
      }
      if (canShoot && bowMode) {
        pfStop()
        const weapon = bot.inventory.slots[bot.inventory.hotbarStart + bot.quickBarSlot]
        if (weapon?.name === 'crossbow') {
          if (!bowCharging) { bot.activateItem(); bowCharging = true; bowChargeTick = physTick }
          else if (physTick - bowChargeTick > 25) { bot.deactivateItem(); bowCharging = false }
        } else if (weapon?.name === 'bow') {
          if (!bowCharging) { bot.activateItem(); bowCharging = true; bowChargeTick = physTick }
          else if (physTick - bowChargeTick > 20) { bot.deactivateItem(); bowCharging = false }
        }
        bot.lookAt(tgtPos.offset(0, 1.0, 0), true).catch(() => {})
        bot.setControlState('sprint', false); bot.setControlState('forward', false)
      } else {
        if (bowMode) { bowMode = false; bowCharging = false; equipBestWeapon() }
        // GoalFollow: pathfinder сам строит путь обходя стены
        // Обновляем каждые 10 тиков (500мс) — не чаще, иначе тормозит
        if (physTick % 10 === 0) {
          pfGo(new goals.GoalFollow(tgt, 2), true)
        }
        bot.setControlState('sprint', true)
        // Банихоп: прыжок при каждом приземлении = ускорение
        if (bot.entity.onGround && jumpCooldown === 0) {
          bot.setControlState('jump', true)
          jumpCooldown = 6
        }
      }

    // ════════════════════════════════════════════════════════════
    // ЗОНА 2: 2.5–5 блоков — КРИТЫ (прыжок → удар при падении)
    // ════════════════════════════════════════════════════════════
    } else if (dist > 2.5) {
      pfStop()  // останавливаем GoalFollow
      bot.setControlState('sprint', false)
      bot.setControlState('back', false)
      bot.setControlState('forward', true)
      bot.setControlState('jump', false)

      if (strafeChangeCd === 0) { strafeDir = Math.random() > 0.5 ? 1 : -1; strafeChangeCd = 10 + Math.floor(Math.random() * 8) }
      bot.setControlState('left',  strafeDir === -1)
      bot.setControlState('right', strafeDir ===  1)

      if (attackReady) {
        if (shieldUp && !creeperBlocking) { bot.deactivateItem(); shieldUp = false }
        if (inWaterCombat) {
          bot.attack(tgt); lastHitTick = physTick; raiseShieldSoon()
        } else {
          const velY = bot.entity.velocity?.y ?? 0
          const isFalling = !bot.entity.onGround && velY < -0.08
          if (isFalling) {
            bot.attack(tgt); lastHitTick = physTick; raiseShieldSoon()
          } else if (bot.entity.onGround && jumpCooldown === 0) {
            bot.setControlState('jump', true); jumpCooldown = 14
          }
        }
      }

    // ════════════════════════════════════════════════════════════
    // ЗОНА 3: < 2.5 блока — СПЛЭШ (полный кулдаун, без прыжка)
    // attackReady=10 тиков обеспечивает не-спам
    // ════════════════════════════════════════════════════════════
    } else {
      pfStop()
      bot.setControlState('sprint', false)
      bot.setControlState('jump', false)

      if (strafeChangeCd === 0) { strafeDir = Math.random() > 0.5 ? 1 : -1; strafeChangeCd = 8 + Math.floor(Math.random() * 4) }
      bot.setControlState('left',  strafeDir === -1)
      bot.setControlState('right', strafeDir ===  1)

      // Отступаем только если ОЧЕНЬ вплотную (< 1.5 блока)
      if (dist < 1.5) {
        bot.setControlState('forward', false); bot.setControlState('back', true)
      } else {
        bot.setControlState('forward', true); bot.setControlState('back', false)
      }

      if (attackReady) {
        if (shieldUp && !creeperBlocking) { bot.deactivateItem(); shieldUp = false }
        bot.attack(tgt); lastHitTick = physTick; raiseShieldSoon()
      }
    }
  }

  // После удара поднимаем щит через 50мс
  function raiseShieldSoon () {
    if (axeMode || creeperBlocking) return  // крипер = щит всегда
    setTimeout(() => {
      if (!combatTarget) return
      const offhand = bot.inventory.slots[45]
      if (!offhand || !offhand.name.includes('shield')) {
        const s = getShield()
        if (s) bot.equip(s, 'off-hand').then(() => { bot.activateItem(true); shieldUp = true }).catch(() => {})
      } else {
        bot.activateItem(true); shieldUp = true
      }
    }, 50)
  }

  // В бою: щит активен КАЖДЫЙ ТИК (кроме момента удара)
  let shieldHoldTick = 0
  let shieldEquipLock = false
  function tickShieldHold () {
    // Не держим щит при стрельбе из лука/арбалета/трезубца
    if (!combatTarget || axeMode || bowMode || tridentMode) return
    shieldHoldTick++

    // Если крипер взрывается — держим щит И смотрим на него (уже делает tickCreeperAlert)
    // Каждые 10 тиков — проверяем что щит в offhand
    if (shieldHoldTick % 10 === 0 && !shieldEquipLock) {
      const offhand = bot.inventory.slots[45]
      const hasShieldInOffhand = offhand && offhand.name.includes('shield')
      if (!hasShieldInOffhand) {
        const s = getShield()
        if (s) {
          shieldEquipLock = true
          bot.equip(s, 'off-hand')
            .then(() => { bot.activateItem(true); shieldUp = true })
            .catch(() => {})
            .finally(() => { shieldEquipLock = false })
          return
        }
      }
    }

    // Каждый тик держим activateItem(true) — анимация + блокировка
    if (!axeMode && !shieldEquipLock) {
      const offhand = bot.inventory.slots[45]
      if (offhand && offhand.name.includes('shield')) {
        bot.activateItem(true)  // off-hand = true
        shieldUp = true
      }
    }
  }

  // ─── АВТО-ЩИТOВ ПОСЛЕ ПОЛОМКИ ──────────────────────────────────
  // entityEquipmentChange уже есть — оставляем как есть

  // Экипировать щит в off-hand и активировать блокировку
  // В mineflayer: activateItem() активирует main hand
  // Для off-hand нужен bot.activateItem(false) в старых версиях
  // или просто equip в off-hand — сервер понимает блокировку
  // activateOffhand: активирует off-hand предмет (щит)
  // В mineflayer правая кнопка мыши = activateItem()
  // off-hand активируется тем же вызовом — сервер выбирает сам
  // activateItem(true) = off-hand (официальная документация mineflayer)
  // activateItem()    = main hand (default)
  // activateItem(false) = main hand явно
  function activateOffhand () {
    bot.activateItem(true)
  }

  function equipShieldAndBlock () {
    const s = getShield()
    if (!s) return
    const offhand = bot.inventory.slots[45]
    if (!offhand || !offhand.name.includes('shield')) {
      bot.equip(s, 'off-hand').then(() => {
        setTimeout(() => { activateOffhand(); shieldUp = true }, 100)
      }).catch(() => {})
    } else {
      activateOffhand(); shieldUp = true
    }
  }

  // Опустить щит (деактивировать блокировку)
  function lowerShield () {
    if (!shieldUp) return
    bot.deactivateItem()
    shieldUp = false
  }

  // ════════════════════════════════════════════════════════════════
  //  КРАФТ
  // ════════════════════════════════════════════════════════════════
  async function smartCraft (itemName, count = 1) {
    if (!mcData) return bot.chat('❌ Не готов')
    const item = mcData.itemsByName[itemName]
    if (!item) return bot.chat('❌ "' + itemName + '" неизвестен (используй англ. название)')

    let craftTable = null
    let rec = bot.recipesFor(item.id, null, count, null)
    if (!rec.length) {
      const tbId = mcData.blocksByName['crafting_table']?.id
      const tb = tbId ? bot.findBlock({ matching: tbId, maxDistance: 64 }) : null
      if (tb) { rec = bot.recipesFor(item.id, null, count, tb); craftTable = tb }
    }
    if (!rec.length) return bot.chat('❌ Нет рецепта для "' + itemName + '"')

    if (craftTable) {
      bot.chat('🔨 Иду к верстаку...')
      pfGo(new goals.GoalNear(craftTable.position.x, craftTable.position.y, craftTable.position.z, 2))
      await waitFor(() => bot.entity.position.distanceTo(craftTable.position) < 3, 12000).catch(() => {})
    }

    try {
      await bot.craft(rec[0], count, craftTable)
      bot.chat('✅ Скрафтил ' + count + '× ' + itemName + '!')
      return true
    } catch (e) { bot.chat('❌ Крафт: ' + e.message); return false }
  }

  // Крафт и выброс игроку
  async function craftAndGive (itemName, count, playerName) {
    const ok = await smartCraft(itemName, count)
    if (!ok) return
    const pl = bot.players[playerName]?.entity
    if (!pl) return bot.chat('❌ Не вижу ' + playerName + '!')
    pfGo(new goals.GoalNear(pl.position.x, pl.position.y, pl.position.z, 2))
    await waitFor(() => bot.entity.position.distanceTo(pl.position) < 3, 8000).catch(() => {})
    pfStop()
    const it = bot.inventory.items().find(i => i.name.includes(itemName))
    if (it) { await bot.toss(it.type, null, Math.min(count, it.count)); bot.chat('🎁 Держи, ' + playerName + '!') }
  }

  // ════════════════════════════════════════════════════════════════
  //  ПЕЧЬ
  // ════════════════════════════════════════════════════════════════
  async function smeltItem (itemName, count = 1) {
    if (!mcData) return bot.chat('❌ Не готов')
    const fId = mcData.blocksByName['furnace']?.id
    const furnaceBlock = fId ? bot.findBlock({ matching: fId, maxDistance: 32 }) : null
    if (!furnaceBlock) return bot.chat('❌ Нет печки рядом!')
    const item = bot.inventory.items().find(i => i.name.includes(itemName))
    if (!item) return bot.chat('❌ "' + itemName + '" нет!')
    pfGo(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2))
    await waitFor(() => bot.entity.position.distanceTo(furnaceBlock.position) < 3, 5000).catch(() => {})
    try {
      const furnace = await bot.openFurnace(furnaceBlock)
      await furnace.putInput(item.type, null, Math.min(count, item.count))
      const fuel = bot.inventory.items().find(i => i.name.includes('coal') || i.name.includes('log'))
      if (fuel) await furnace.putFuel(fuel.type, null, Math.ceil(count / 8))
      furnace.close(); bot.chat('🔥 Плавлю ' + count + '× ' + item.name)
    } catch (e) { bot.chat('❌ Печь: ' + e.message) }
  }

  // ════════════════════════════════════════════════════════════════
  //  ЗЕЛЬЯ / ЗАЧАРОВАНИЕ
  // ════════════════════════════════════════════════════════════════
  async function brewPotion (potionType) {
    const ingredient = POTION_RECIPES[potionType]
    if (!ingredient) return bot.chat('❌ Типы: ' + Object.keys(POTION_RECIPES).join(', '))
    const bottle = bot.inventory.items().find(i => i.name.includes('water_bottle') || i.name.includes('potion'))
    const ing    = bot.inventory.items().find(i => i.name.includes(ingredient))
    if (!bottle) return bot.chat('❌ Нет бутылки с водой!')
    if (!ing) return bot.chat('❌ Нет ингредиента: ' + ingredient)
    if (!mcData) return
    const standId = mcData.blocksByName['brewing_stand']?.id
    const stand = standId ? bot.findBlock({ matching: standId, maxDistance: 32 }) : null
    if (!stand) return bot.chat('❌ Нет стойки!')
    pfGo(new goals.GoalNear(stand.position.x, stand.position.y, stand.position.z, 2))
    await waitFor(() => bot.entity.position.distanceTo(stand.position) < 3, 5000).catch(() => {})
    try {
      const bs = await bot.openBrewingStand(stand)
      const blaze = bot.inventory.items().find(i => i.name.includes('blaze_powder'))
      if (blaze) await bs.putFuel(blaze.type, null, 1)
      await bs.putIngredient(ing.type, null, 1)
      bot.chat('🧪 Варю ' + potionType + '... (~20с)')
      await sleep(22000); bs.close(); bot.chat('✅ Готово!')
    } catch (e) { bot.chat('❌ Зелье: ' + e.message) }
  }

  async function enchantItem (itemName) {
    if (!mcData) return
    const tableId = mcData.blocksByName['enchanting_table']?.id
    const table = tableId ? bot.findBlock({ matching: tableId, maxDistance: 32 }) : null
    if (!table) return bot.chat('❌ Нет стола зачарований!')
    const item  = bot.inventory.items().find(i => i.name.includes(itemName))
    if (!item) return bot.chat('❌ "' + itemName + '" нет!')
    const lapis = bot.inventory.items().find(i => i.name.includes('lapis'))
    if (!lapis) return bot.chat('❌ Нет лазурита!')
    pfGo(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2))
    await waitFor(() => bot.entity.position.distanceTo(table.position) < 3, 5000).catch(() => {})
    try {
      await bot.equip(item, 'hand')
      const et = await bot.openEnchantmentTable(table)
      await sleep(1000)
      const enchants = et.enchantments
      if (!enchants?.length) { et.close(); return bot.chat('❌ Нет зачарований (нужны книжные шкафы + опыт)') }
      const best = enchants.reduce((a, b) => (b.level > a.level) ? b : a, enchants[0])
      await et.enchant(best.level - 1)
      et.close(); bot.chat('✨ Зачарован!')
    } catch (e) { bot.chat('❌ ' + e.message) }
  }

  // ════════════════════════════════════════════════════════════════
  //  СУНДУК
  // ════════════════════════════════════════════════════════════════
  async function chestAction (action, itemName, count = 1) {
    const chestBlock = bot.findBlock({
      matching: b => b.name && (b.name.includes('chest') || b.name.includes('barrel') || b.name.includes('shulker')),
      maxDistance: 16
    })
    if (!chestBlock) return bot.chat('❌ Нет сундука рядом!')
    pfGo(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2))
    await waitFor(() => bot.entity.position.distanceTo(chestBlock.position) < 3, 5000).catch(() => {})
    let chest
    try { chest = await bot.openContainer(chestBlock) } catch (e) { return bot.chat('❌ ' + e.message) }
    try {
      if (action === 'проверить') {
        const items = chest.containerItems()
        if (!items.length) { chest.close(); return bot.chat('📦 Сундук пуст') }
        const sum = {}; items.forEach(i => { sum[i.name] = (sum[i.name] || 0) + i.count })
        await chatLong('📦 ' + Object.keys(sum).map(n => n + '×' + sum[n]).join(' '))
      } else if (action === 'положить' && itemName) {
        const it = bot.inventory.items().find(i => i.name.includes(itemName))
        if (!it) { chest.close(); return bot.chat('❌ "' + itemName + '" нет!') }
        await chest.deposit(it.type, null, Math.min(count, it.count))
        bot.chat('✅ Положил ' + Math.min(count, it.count) + '× ' + it.name)
      } else if (action === 'взять' && itemName) {
        const it = chest.containerItems().find(i => i.name.includes(itemName))
        if (!it) { chest.close(); return bot.chat('❌ "' + itemName + '" нет в сундуке') }
        await chest.withdraw(it.type, null, Math.min(count, it.count))
        bot.chat('✅ Взял ' + Math.min(count, it.count) + '× ' + it.name)
      }
    } catch (e) { bot.chat('❌ ' + e.message) }
    chest.close()
  }

  // Взять предмет из сундука(ов) и выбросить игроку
  // Ищет во ВСЕХ сундуках в радиусе 32 блоков
  async function giveFromChest (itemName, count, playerName) {
    const isAll = !itemName || itemName === 'всё' || itemName === 'all'
    const searchRadius = 32

    // Находим все сундуки/бочки/шалкеры в радиусе
    const chestPositions = bot.findBlocks({
      matching: b => b.name && (b.name.includes('chest') || b.name.includes('barrel') || b.name.includes('shulker')),
      maxDistance: searchRadius,
      count: 50
    })

    if (!chestPositions.length) return bot.chat('❌ Нет сундуков в радиусе ' + searchRadius + ' блоков!')

    // Сортируем по расстоянию
    const chestBlocks = chestPositions
      .map(p => bot.blockAt(p))
      .filter(b => b)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))

    bot.chat('🔍 Ищу' + (isAll ? ' всё' : ' "' + itemName + '"') + ' в ' + chestBlocks.length + ' сундуках...')

    const collectedItems = []  // { name, type, count }
    let checkedCount = 0

    for (const chestBlock of chestBlocks) {
      // Идём к сундуку
      pfGo(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2))
      await waitFor(() => bot.entity.position.distanceTo(chestBlock.position) < 3, 6000).catch(() => {})
      pfStop()

      let chest
      try { chest = await bot.openContainer(chestBlock) } catch (_) { continue }

      try {
        const items = chest.containerItems()
        checkedCount++

        let toTake = []
        if (isAll) {
          toTake = items.slice(0, 27)
        } else {
          toTake = items.filter(i =>
            i.name.includes(itemName) ||
            i.displayName?.toLowerCase().includes(itemName.toLowerCase())
          )
        }

        let remaining = count > 0 ? count - collectedItems.reduce((s, i) => s + i.count, 0) : 99999

        for (const item of toTake) {
          if (remaining <= 0) break
          const takeCount = Math.min(remaining, item.count)
          try {
            await chest.withdraw(item.type, null, takeCount)
            collectedItems.push({ name: item.name, type: item.type, count: takeCount })
            remaining -= takeCount
            await sleep(40)
          } catch (_) {}
        }
      } catch (_) {}
      try { chest.close() } catch (_) {}
      await sleep(100)

      // Если нашли нужное количество — останавливаемся
      if (count > 0 && collectedItems.reduce((s, i) => s + i.count, 0) >= count) break
      // Если брали всё — после первого непустого сундука решаем сами
    }

    if (!collectedItems.length) {
      return bot.chat('❌ ' + (isAll ? 'Все сундуки пусты!' : '"' + itemName + '" не найден ни в одном сундуке!'))
    }

    const totalCount = collectedItems.reduce((s, i) => s + i.count, 0)
    const uniqueNames = [...new Set(collectedItems.map(i => i.name))]

    // Идём к игроку и выбрасываем
    const pl = bot.players[playerName]?.entity
    if (!pl) {
      bot.chat('✅ Взял ' + totalCount + ' шт из ' + checkedCount + ' сундуков. (не вижу ' + playerName + ')')
      return
    }
    bot.chat('🏃 Несу ' + totalCount + ' шт...')
    pfGo(new goals.GoalNear(pl.position.x, pl.position.y, pl.position.z, 2))
    await waitFor(() => bot.entity.position.distanceTo(pl.position) < 3, 8000).catch(() => {})
    pfStop()

    let gave = 0
    for (const collected of collectedItems) {
      const have = bot.inventory.items().find(i => i.name === collected.name)
      if (have) {
        await bot.toss(have.type, null, have.count).catch(() => {})
        gave += have.count
        await sleep(50)
      }
    }
    bot.chat('🎁 ' + playerName + ', держи! ' + gave + ' шт (' + uniqueNames.slice(0, 3).join(', ') + (uniqueNames.length > 3 ? '...' : '') + ')')
  }

  // ════════════════════════════════════════════════════════════════
  //  ФЕРМЫ
  // ════════════════════════════════════════════════════════════════
  async function buildFarm (farmType) {
    const blueprint = FARM_BLUEPRINTS[farmType]
    if (!blueprint) return bot.chat('❌ Типы: ' + Object.keys(FARM_BLUEPRINTS).join(', '))
    bot.chat('🏗️ Строю: ' + farmType)
    const base = bot.entity.position.floored()
    for (const step of blueprint) {
      if (MODE !== 'farm') break
      const tp = base.offset(step.dx, step.dy, step.dz)
      const have = bot.inventory.items().find(i => i.name === step.block)
      if (!have) { bot.chat('⚠️ Нет: ' + step.block); continue }
      try {
        // Явно сбрасываем управление перед каждым шагом
        bot.clearControlStates()
        pfGo(new goals.GoalNear(tp.x, tp.y + 1, tp.z, 2))
        await waitFor(() => bot.entity.position.distanceTo(tp) < 4, 5000).catch(() => {})
        pfStop()
        bot.clearControlStates()  // стоп после прибытия
        await sleep(100)
        await bot.equip(have, 'hand')
        const ref = bot.blockAt(tp.offset(0, -1, 0))
        if (ref) await bot.placeBlock(ref, new Vec3(0, 1, 0))
        await sleep(100)
      } catch (_) {}
    }
    bot.clearControlStates(); pfStop()
    bot.chat('✅ Ферма готова!')
    if (MODE === 'farm') MODE = null
  }

  // ════════════════════════════════════════════════════════════════
  //  AI — ВЫПОЛНЕНИЕ КОМАНДЫ
  // ════════════════════════════════════════════════════════════════
  async function executeAiCmd (cmdObj, fromUser) {
    const cmd  = cmdObj.cmd  || 'say'
    const args = cmdObj.args || []
    if (cmd === 'say') return

    if (cmd === 'stop') { fullStop('🛑 Остановился.'); return }

    if (cmd === 'goto_player') {
      const ent = bot.players[fromUser]?.entity
      if (!ent) return bot.chat('❌ Не вижу тебя!')
      fullStop(); MODE = 'goto'
      pfGo(new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2))
      bot.chat('🏃 Иду!')
      const _gt = setTimeout(() => { pfStop(); MODE = null }, 12000)
      const _gc = setInterval(() => {
        if (MODE !== 'goto') { clearInterval(_gc); clearTimeout(_gt); return }
        if (!bot.entity) return
        if (bot.entity.position.distanceTo(ent.position) < 3) {
          clearInterval(_gc); clearTimeout(_gt); pfStop(); MODE = null
        }
      }, 300)
      return
    }

    if (cmd === 'follow') {
      const who = args[0] || fromUser; fullStop(); MODE = 'follow'; modeMeta = { who }
      bot.chat('👣 Следую за ' + who); return
    }

    if (cmd === 'collect' || cmd === 'farm') {
      const blockName = args[0]; const count = parseInt(args[1]) || 16
      if (!blockName || !mcData) return bot.chat('❌ Не знаю что добывать')

      const aliasNames = BLOCK_ALIASES[blockName] || [blockName]
      const aliasIds = aliasNames.map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
      if (!aliasIds.length) return bot.chat('❌ "' + blockName + '" неизвестен')

      fullStop(); MODE = 'farm'; isMining = true
      bot.chat('⛏️ Добываю ' + count + '× ' + blockName + '...')

      let got = 0, skipPos = new Set(), noFindCount = 0

      while (MODE === 'farm' && got < count) {
        // Найти ближайший блок (пропускаем помеченные как недостижимые)
        const blk = bot.findBlock({
          matching: b => b && b.position && aliasIds.includes(b.type) && !skipPos.has(b.position.toString()),
          maxDistance: 100, count: 1
        })
        if (!blk) {
          noFindCount++
          if (noFindCount >= 3) { bot.chat('❌ ' + blockName + ' не найден!'); break }
          skipPos.clear(); await sleep(500); continue
        }
        noFindCount = 0
        const bpos = blk.position

        // Идём к блоку через pathfinder (обходит стены сам)
        pfGo(new goals.GoalNear(bpos.x, bpos.y, bpos.z, 2))
        const arrived = await waitFor(
          () => bot.entity.position.distanceTo(bpos) <= 4 || !bot.pathfinder.isMoving(),
          15000
        ).then(() => true).catch(() => false)
        pfStop(); bot.clearControlStates()

        if (bot.entity.position.distanceTo(bpos) > 5) {
          skipPos.add(bpos.toString()); continue  // недостижим
        }

        // Перепроверяем блок
        const target = bot.blockAt(bpos)
        if (!target || !aliasIds.includes(target.type)) continue

        // Проверяем LOS, если нет — ломаем мешающий блок
        const eyePos = bot.entity.position.offset(0, 1.6, 0)
        const tCenter = bpos.offset(0.5, 0.5, 0.5)
        let ray = bot.world.raycast(eyePos, tCenter.minus(eyePos).normalize(), bpos.distanceTo(eyePos) + 1)
        // Если LOS заблокирован — ломаем мешающие блоки (до 3 штук)
        let obsCount = 0
        while (ray && ray.position && !ray.position.equals(bpos) && obsCount < 3) {  // ray.position null-safe
          obsCount++
          const obs = bot.blockAt(ray.position)
          if (!obs || ['air','water','flowing_water','lava'].includes(obs.name)) break
          try {
            await bot.lookAt(ray.position.offset(0.5, 0.5, 0.5), true)
            try { await bot.tool.equipForBlock(obs) } catch (_) {}
            await Promise.race([
              bot.dig(obs),
              new Promise((_, rej) => setTimeout(() => rej(new Error('obs timeout')), 8000))
            ])
            await sleep(100)
            // Пересчитываем ray для того же целевого блока
            const eyePos2 = bot.entity.position.offset(0, 1.6, 0)
            const ray2 = bot.world.raycast(eyePos2, tCenter.minus(eyePos2).normalize(), bpos.distanceTo(eyePos2) + 1)
            if (!ray2 || !ray2.position || ray2.position.equals(bpos)) break
            // обновляем ray для следующей итерации
            // eslint-disable-next-line no-param-reassign
            ray = ray2
          } catch (de) {
            try { bot.stopDigging() } catch (_) {}
            break
          }
        }
        // Перепроверяем LOS после сноса мешающих блоков
        {
          const eyePos2 = bot.entity.position.offset(0, 1.6, 0)
          const ray2 = bot.world.raycast(eyePos2, tCenter.minus(eyePos2).normalize(), bpos.distanceTo(eyePos2) + 1)
          if (ray2 && ray2.position && !ray2.position.equals(bpos)) {
            skipPos.add(bpos.toString()); continue  // всё ещё нет LOS — пропускаем
          }
        }

        // Копаем целевой блок
        try { await bot.tool.equipForBlock(target) } catch (_) {}
        await bot.lookAt(tCenter, true); await sleep(50)
        try {
          // Timeout на dig: если копаем дольше 10 секунд — пропускаем
          await Promise.race([
            bot.dig(target),
            new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), 10000))
          ])
          got++; if (got % 4 === 0) bot.chat('📦 ' + got + '/' + count)
          await sleep(200)  // ждём дроп перед следующим
        } catch (de) {
          try { bot.stopDigging() } catch (_) {}
          if (/same type|already/i.test(de.message)) { got++; continue }
          skipPos.add(bpos.toString()); await sleep(300)
        }
      }

      isMining = false; pfStop()
      if (got >= count) bot.chat('✅ Добыл ' + got + '× ' + blockName + '!')
      else if (got > 0) bot.chat('📦 Добыл ' + got + '/' + count + '× ' + blockName)
      if (MODE === 'farm') MODE = null; return
    }

    if (cmd === 'craft') { await smartCraft(args[0], parseInt(args[1]) || 1); return }

    if (cmd === 'craft_give') {
      await craftAndGive(args[0], parseInt(args[1]) || 1, args[2] || fromUser); return
    }

    if (cmd === 'equip_armor') { await equipBestArmor(); bot.chat('🛡️ Броня надета!'); return }
    if (cmd === 'toggle_armor') {
      autoArmor = !autoArmor
      bot.chat('🛡️ Автоброня: ' + (autoArmor ? '✅ вкл' : '❌ выкл'))
      return
    }
    if (cmd === 'toss_item') {
      const searchName = (args[0] || '').toLowerCase()
      const wantCount  = parseInt(args[1]) || 64  // по умолчанию весь стак
      if (!searchName) return bot.chat('❌ Что выбросить?')

      // Собираем ВСЕ предметы: инвентарь + надетые слоты (броня 5-8, offhand 45)
      const seenTypes = new Set()
      const allItems = []

      // Сначала инвентарь (items() включает hotbar + основной инвентарь)
      for (const item of bot.inventory.items()) {
        if (item && !seenTypes.has(item.slot)) {
          seenTypes.add(item.slot)
          allItems.push(item)
        }
      }
      // Надетые слоты: шлем(5), нагрудник(6), поножи(7), ботинки(8), offhand(45)
      for (const slotIdx of [5, 6, 7, 8, 45]) {
        const it = bot.inventory.slots[slotIdx]
        if (it && !seenTypes.has(slotIdx)) {
          seenTypes.add(slotIdx)
          allItems.push(it)
        }
      }

      const matches = allItems.filter(i => i && i.name.toLowerCase().includes(searchName))

      if (!matches.length) {
        // Показываем что есть похожего
        const allNames = allItems.map(i => i.name).join(', ')
        bot.chat('❌ "' + searchName + '" не найдено. Есть: ' + allNames.slice(0, 100))
        return
      }

      // Идём к игроку если далеко
      const ent2 = bot.players[fromUser]?.entity
      if (ent2 && bot.entity.position.distanceTo(ent2.position) > 4) {
        pfGo(new goals.GoalNear(ent2.position.x, ent2.position.y, ent2.position.z, 2))
        await waitFor(() => bot.entity.position.distanceTo(ent2.position) < 4, 8000).catch(() => {})
        pfStop(); if (MODE === 'goto') MODE = null
      }

      let tossed = 0
      for (const item of matches) {
        if (tossed >= wantCount) break
        const cnt = Math.min(wantCount - tossed, item.count)
        try {
          // Для надетых предметов сначала снимаем
          if ([5,6,7,8,45].includes(item.slot)) {
            await bot.unequip(
              item.slot === 5 ? 'head' :
              item.slot === 6 ? 'torso' :
              item.slot === 7 ? 'legs' :
              item.slot === 8 ? 'feet' : 'off-hand'
            ).catch(() => {})
            await sleep(100)
          }
          await bot.toss(item.type, null, cnt)
          tossed += cnt
        } catch (e) { console.log('toss err:', e.message) }
        await sleep(60)
      }
      if (tossed > 0) bot.chat('🎁 Держи: ' + matches[0].name + ' ×' + tossed)
      else bot.chat('❌ Не смог выбросить')
      return
    }

    if (cmd === 'attack') {
      const name = (args[0] || '').toLowerCase()
      const tgt  = bot.nearestEntity(e => e.isValid &&
        ((e.name?.toLowerCase().includes(name)) || (e.username?.toLowerCase().includes(name))))
      if (!tgt) return bot.chat('❌ "' + name + '" не найден!')
      fullStop(); MODE = 'attack'; equipBestWeapon(); startCombat(tgt); return
    }

    if (cmd === 'status') {
      const p = bot.entity.position
      bot.chat('❤️' + Math.round(bot.health) + '/20 🍖' + Math.round(bot.food) + '/20 📍' +
        p.x.toFixed(0) + ' ' + p.y.toFixed(0) + ' ' + p.z.toFixed(0) + ' [' + behaviorMode + ']'); return
    }

    if (cmd === 'smelt') { await smeltItem(args[0], parseInt(args[1]) || 1); return }

    if (cmd === 'sleep') { await trySleep(fromUser); return }

    if (cmd === 'wake') {
      if (bot.isSleeping) { await bot.wake().catch(e => bot.chat('❌ ' + e.message)); bot.chat('☀️ Проснулся!') }
      else bot.chat('Я и не сплю.')
      return
    }

    if (cmd === 'eat') {
      const food = bot.inventory.items().find(i => isFood(i.name))
      if (!food) { bot.chat('❌ Еды нет!'); return }
      try {
        await bot.equip(food, 'hand')
        await bot.consume()
        bot.chat('🍖 Поел! HP:' + Math.round(bot.health) + ' 🍖' + Math.round(bot.food))
      } catch (e) { bot.chat('❌ ' + e.message) }
      return
    }

    if (cmd === 'chest_open') { await chestAction('проверить'); return }
    if (cmd === 'chest_give') {
      const itemN = args[0] || 'всё'
      const cnt   = parseInt(args[1]) || 0
      await giveFromChest(itemN, cnt, fromUser); return
    }
    if (cmd === 'help') { await showHelp(); return }
  }

  // ════════════════════════════════════════════════════════════════
  //  AI — ОБРАБОТКА СВОБОДНОГО ТЕКСТА
  // ════════════════════════════════════════════════════════════════
  async function handleAiMessage (fromUser, text) {
    const hasKey = GROQ_KEY || CEREBRAS_KEY
    if (!hasKey) {
      bot.chat('🤖 ИИ выкл. Нет API ключа. Пиши команды с !')
      return
    }

    const invSummary = (() => {
      const sum = {}; bot.inventory.items().forEach(i => { sum[i.name] = (sum[i.name] || 0) + i.count })
      return Object.keys(sum).slice(0, 8).map(n => n + '×' + sum[n]).join(', ')
    })()

    const ctx = '[Игрок: ' + fromUser + '] [Инв: ' + (invSummary || 'пусто') + '] [Поз: ' +
      bot.entity.position.x.toFixed(0) + ' ' + bot.entity.position.z.toFixed(0) + ']\n' + text

    bot.chat('🤖 ...')

    try {
      // Подставляем имя игрока в системный промпт
      const sysPrompt = AI_SYSTEM.replace('PLAYER_NAME', fromUser)
      const response = await callAI(sysPrompt, ctx)

      // Логируем полный ответ для отладки
      console.log('🤖 AI raw response:', JSON.stringify(response))

      // ── Парсинг ответа ─────────────────────────────────────────
      // Ищем JSON ВЕЗДЕ: в любом месте текста, через /, в markdown, на отдельной строке
      let cmdJson = null

      // Извлекаем ЛЮБОЙ JSON-объект с полем "cmd" из ответа
      // Regex: ищем { ... "cmd" ... } даже в середине текста
      const jsonMatches = response.match(/\{[^{}]*"cmd"[^{}]*\}/g) || []
      for (const m of jsonMatches) {
        try {
          const parsed = JSON.parse(m)
          if (parsed.cmd) { cmdJson = parsed; break }
        } catch (_) {}
      }

      // Если не нашли простым regex — ищем через JSON.parse по позициям
      if (!cmdJson) {
        for (let i = 0; i < response.length; i++) {
          if (response[i] !== '{') continue
          for (let j = i + 2; j < Math.min(i + 300, response.length); j++) {
            if (response[j] !== '}') continue
            try {
              const sub = response.slice(i, j + 1)
              const p = JSON.parse(sub)
              if (p && p.cmd) { cmdJson = p; break }
            } catch (_) {}
          }
          if (cmdJson) break
        }
      }

      // Текст ответа: убираем JSON и мусор
      const replyText = response
        .replace(/```(?:json)?[\s\S]*?```/g, '')
        .replace(/\{[^{}]*\}/g, '')
        .replace(/\/\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
      if (replyText) bot.chat('🤖 ' + replyText)

      // Выполняем команду
      if (cmdJson && cmdJson.cmd) {
        console.log('✅ AI cmd parsed:', JSON.stringify(cmdJson))
        await sleep(150)
        await executeAiCmd(cmdJson, fromUser)
      } else {
        console.log('⚠️ AI: no cmd found in response')
      }
    } catch (e) {
      bot.chat('🤖 Ошибка ИИ: ' + e.message.slice(0, 80))
      console.error('AI error:', e.message)
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  СОН — ищет свободную кровать в радиусе 32 блоков
  // ════════════════════════════════════════════════════════════════
  async function trySleep (requester) {
    if (!mcData) return bot.chat('❌ Не готов')
    if (bot.isSleeping) return bot.chat('💤 Я уже сплю!')

    // Собираем все кровати в радиусе 32
    const beds = []
    bot.findBlocks({
      matching: b => bot.isABed(b),
      maxDistance: 32,
      count: 20
    }).forEach(pos => {
      const bl = bot.blockAt(pos)
      if (bl) beds.push(bl)
    })

    if (!beds.length) return bot.chat('❌ Нет кроватей в радиусе 32 блоков!')

    // Сортируем по расстоянию
    beds.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))

    bot.chat('🛏️ Ищу свободную кровать (' + beds.length + ' шт)...')
    fullStop()

    for (const bed of beds) {
      pfGo(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2))
      await waitFor(() => bot.entity.position.distanceTo(bed.position) < 3, 6000).catch(() => {})
      pfStop()
      try {
        await bot.sleep(bed)
        bot.chat('💤 Сплю~')
        return
      } catch (e) {
        // Кровать занята или нельзя — пробуем следующую
        const reason = e.message || ''
        if (reason.toLowerCase().includes('occupied') || reason.includes('занята')) {
          bot.chat('🛏️ Занята, ищу другую...')
          continue
        }
        // Другая ошибка (не ночь, блокирована и т.д.)
        bot.chat('❌ ' + e.message)
        return
      }
    }
    bot.chat('❌ Все кровати заняты!')
  }

  // ════════════════════════════════════════════════════════════════
  //  ПОМОЩЬ — отправляется несколькими большими сообщениями
  // ════════════════════════════════════════════════════════════════
  async function showHelp () {
    const msgs = [
      '━━━ 🤖 AI_Guardian v8.0 ━━━ ' +
      '🧠 Пиши свободно без ! → ИИ поймёт и выполнит: ' +
      '"добудь алмазы" | "скрафти меч и отдай мне" | "иди сюда" | "что у тебя есть"',

      '🚶 ДВИЖЕНИЕ: !за мной | !ко мне | !приди X Z [Y] | !стоп | !спринт | !прыгни | !стоп следуй | !вылези (выйти из транспорта)',

      '📍 ТОЧКИ: !сохрани [имя] | !пресеты | !иди [имя] | !точка (запомнить базу) | !вернуться | !действие [имя] [стой|нажми_рычаг|нажми_кнопку]',

      '🚤 ЛОДКА: !лодка → !плыви X Z → !плыви стоп → !вылези  |  💧 ВОДА: авто-спринт+прыжки, следит за кислородом',

      '⚔️ БОЙ: !атакуй <цель> | !убей всё | !охрана | !охрана стоп | !защищай меня | !телохранитель стоп | !режим мирный/защита/агрессия',

      '🛡️ ЩИТ: !щит | !щит стоп | !автощит  |  🛡️ БРОНЯ: !броня | !автоброня  Авто: netherite→diamond→iron→gold→chainmail→leather',

      '⛏️ ДОБЫЧА: !копай [кол] <блок> | !собери [кол] <блок> | !фарми <блок> [кол] | !добудь <блок> [кол] | !стоп собирать  |  🏗️ ФЕРМЫ: !ферма тростника/пшеницы/деревьев/автокриперов',

      '🔨 КРАФТ: !крафт <предмет> [кол] | !крафт+дай <предмет> [кол] | !печка <предмет> [кол] | !зелье силы/регенерации/скорости/прыжка/огня/яда | !зачаровать <предмет>',

      '📦 ИНВ: !инв | !сколько <вещь> | !выбрось <вещь/всё/мусор> | !надеть <вещь> | !дай <вещь> | !что сломано | !сортировать  |  🗃️ СУНДУК: !сундук проверить/положить/взять',

      '🍖 !ешь | !автоеда | 🛏️ !спать | !встать | 🗺️ !статус | !где | !где <игрок> | !дист <игрок> | !игроки | !время | !погода | !пинг | !что под',

      '🔄 ПАТРУЛЬ: !патруль добавь|старт|стоп|очисти|список  |  💤 !афк (вращение) | !антиафк  |  💬 !скажи <текст> | !шепни <ник> <текст> | !команда <mc>',
    ]
    for (const m of msgs) { bot.chat(m); await sleep(200) }
  }

  // ════════════════════════════════════════════════════════════════
  //  ОБРАБОТЧИК ЧАТА
  // ════════════════════════════════════════════════════════════════
  bot.on('chat', async (user, message) => {
    if (user === bot.username) return
    lastCmdTime = Date.now()

    const raw = message.trim()
    const msg = raw.toLowerCase()
    const low = msg.split(' ')
    const tok = raw.split(' ')

    // ИИ отвечает ТОЛЬКО если сообщение начинается с "ai ", "ии ", "аи " (регистр не важен)
    if (!raw.startsWith('!')) {
      const aiPrefixes = ['ai ', 'ии ', 'аи ', 'ai,', 'ии,', 'аи,']
      const hasPrefix = aiPrefixes.some(p => msg.startsWith(p))
      if (!hasPrefix) return  // игнорируем без префикса
      // Убираем префикс из текста перед отправкой в ИИ
      const query = raw.slice(raw.indexOf(' ') + 1).trim()
      if (query) await handleAiMessage(user, query)
      return
    }

    // ══ СТОП ════════════════════════════════════════════════════════
    if (msg === '!стоп') { fullStop('🛑 Остановлен.'); return }

    // ══ ТЕСТ ВОДАДРОП ════════════════════════════════════════════════
    if (msg === '!тест водадроп' || msg === '!тест ватердроп' || msg === '!тест') {
      const wb = bot.inventory.items().find(i => i.name === 'water_bucket')
      if (!wb) { bot.chat('❌ Нет water_bucket!'); return }
      bot.chat('💧 Тест water drop...')
      // Фиксируем yaw ДО isWaterDropping=true
      _wdSavedYaw = bot.entity.yaw
      isWaterDropping = true  // physicsTick начнёт писать entity.pitch=-PI/2 (вниз)
      try {
        if (shieldUp) { bot.deactivateItem(); shieldUp = false }
        await bot.equip(wb, 'hand')
        await sleep(100)  // 2 тика — physics engine отправит Look пакет
        bot.activateItem()
        await sleep(200)
        bot.activateItem()
        bot.chat('💧 Вылито! Жду 500мс...')
        await sleep(500)
        await pickUpWater()
        equipBestWeapon()
        bot.chat('✅ Тест завершён!')
      } catch (_) {} finally {
        isWaterDropping = false
        equipBestWeapon()
        if (shieldAuto || combatTarget) { activateOffhand(); shieldUp = true }
      }
      return
    }

    // ══ ТРАНСПОРТ ════════════════════════════════════════════════════
    if (msg === '!вылези' || msg === '!выйди') { dismountVehicle(); return }

    // ══ ДВИЖЕНИЕ ════════════════════════════════════════════════════
    if (msg === '!за мной' || msg === '!следуй') {
      fullStop(); MODE = 'follow'; modeMeta = { who: user }; bot.chat('👣 Следую за ' + user + '!'); return
    }
    if (msg === '!стоп следуй') { if (MODE === 'follow') { MODE = null; pfStop() }; bot.chat('🛑 Стоп.'); return }
    if (msg === '!ко мне') {
      const t = bot.players[user]?.entity; if (!t) return bot.chat('❌ Не вижу тебя!')
      fullStop(); MODE = 'goto'
      pfGo(new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2))
      bot.chat('🏃 Бегу!')
      const _t1 = setTimeout(() => { pfStop(); MODE = null }, 12000)
      const _s1 = setInterval(() => {
        if (MODE !== 'goto') { clearInterval(_s1); clearTimeout(_t1); return }
        if (bot.entity.position.distanceTo(t.position) < 3) {
          clearInterval(_s1); clearTimeout(_t1); pfStop(); MODE = null
        }
      }, 250)
      return
    }
    if (msg.startsWith('!приди ')) {
      const nums = low.slice(1).map(Number).filter(x => !isNaN(x))
      fullStop(); MODE = 'goto'
      if (nums.length === 2) { pfGo(new goals.GoalNear(nums[0], bot.entity.position.y, nums[1], 2)); bot.chat('🏃 X:' + nums[0] + ' Z:' + nums[1]) }
      else if (nums.length >= 3) { pfGo(new goals.GoalNear(nums[0], nums[1], nums[2], 2)); bot.chat('🏃 X:' + nums[0] + ' Y:' + nums[1] + ' Z:' + nums[2]) }
      else bot.chat('❌ !приди X Z'); return
    }
    if (msg === '!прыгни') { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 350); return }
    if (msg === '!спринт') {
      bot.setControlState('sprint', true); bot.setControlState('forward', true)
      setTimeout(() => bot.clearControlStates(), 3000); bot.chat('💨 Бегу 3с!'); return
    }

    // ══ ТОЧКИ ════════════════════════════════════════════════════════
    if (msg.startsWith('!сохрани')) {
      const pn = low[1] || ('pt' + (Object.keys(savedPoints).length + 1))
      const p = bot.entity.position; savedPoints[pn] = { x: p.x, y: p.y, z: p.z, actions: [] }
      bot.chat('📍 "' + pn + '": ' + p.x.toFixed(0) + ' ' + p.y.toFixed(0) + ' ' + p.z.toFixed(0)); return
    }
    if (msg === '!пресеты') {
      const list = Object.keys(savedPoints)
      bot.chat(list.length ? '📍 ' + list.map(n => { const q = savedPoints[n]; return '"'+n+'"('+q.x.toFixed(0)+'/'+q.z.toFixed(0)+')' }).join(' ') : '📍 Нет.'); return
    }
    if (msg.startsWith('!иди ') && low[1]) {
      const pt = savedPoints[low[1]]; if (!pt) return bot.chat('❌ "' + low[1] + '" нет!')
      fullStop(); MODE = 'goto'; pfGo(new goals.GoalNear(pt.x, pt.y, pt.z, 2)); bot.chat('🏃 → "' + low[1] + '"'); return
    }
    if (msg.startsWith('!действие ') && low[1] && low[2]) {
      if (!savedPoints[low[1]]) return bot.chat('❌ "' + low[1] + '" нет!')
      savedPoints[low[1]].actions = savedPoints[low[1]].actions || []; savedPoints[low[1]].actions.push(low[2])
      bot.chat('✅ "' + low[2] + '" → "' + low[1] + '"'); return
    }
    if (msg === '!точка') { basePos = bot.entity.position.clone(); bot.chat('🏠 База: ' + basePos.x.toFixed(0) + ' ' + basePos.y.toFixed(0) + ' ' + basePos.z.toFixed(0)); return }
    if (msg === '!вернуться') {
      if (!basePos) return bot.chat('❌ База не задана! → !точка')
      fullStop(); MODE = 'goto'; pfGo(new goals.GoalNear(basePos.x, basePos.y, basePos.z, 2)); bot.chat('🏠 На базу...'); return
    }

    // ══ ЛОДКА ════════════════════════════════════════════════════════
    if (msg === '!лодка') {
      const boat = bot.nearestEntity(e => e.name && e.name.toLowerCase().includes('boat'))
      if (!boat) return bot.chat('❌ Нет лодки!')
      fullStop(); bot.chat('🚤 Иду...')
      pfGo(new goals.GoalNear(boat.position.x, boat.position.y, boat.position.z, 1.5))
      const chk = setInterval(() => {
        if (bot.vehicle) { clearInterval(chk); bot.chat('✅ В лодке!'); return }
        if (bot.entity.position.distanceTo(boat.position) < 2.5) { clearInterval(chk); pfStop(); try { bot.mount(boat) } catch (_) {} }
      }, 300)
      setTimeout(() => clearInterval(chk), 15000); return
    }
    if (msg.startsWith('!плыви ') && low[1] !== 'стоп') {
      if (!bot.vehicle) return bot.chat('❌ Сначала !лодка')
      const bx = parseFloat(low[1]), bz = parseFloat(low[2])
      if (isNaN(bx) || isNaN(bz)) return bot.chat('❌ !плыви X Z')
      boatGo(bx, bz); bot.chat('🚤 X:' + bx + ' Z:' + bz); return
    }
    if (msg === '!плыви стоп') { boatStop(); bot.chat('⚓ Стоп.'); return }

    // ══ СОН ══════════════════════════════════════════════════════════
    if (msg === '!спать') {
      await trySleep(user); return
    }
    if (msg === '!проснись' || msg === '!встать') {
      if (bot.isSleeping) { await bot.wake().catch(() => {}); bot.chat('☀️ Проснулся!') } else bot.chat('Я не сплю.'); return
    }

    // ══ ДОБЫЧА ═══════════════════════════════════════════════════════
    if (msg.startsWith('!копай ') || msg.startsWith('!фарми ') || msg.startsWith('!добудь ')) {
      const args = low.slice(1); let bName, count = 1
      if (!isNaN(parseInt(args[0]))) { count = parseInt(args[0]); bName = args[1] } else { bName = args[0]; count = parseInt(args[1]) || 1 }
      if (!bName || !mcData) return bot.chat('❌ !копай [кол] <блок>')
      // Поддерживаем alias (deepslate и пр.)
      const aliasNames = BLOCK_ALIASES[bName] || [bName]
      const aliasIds = aliasNames.map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
      if (!aliasIds.length) return bot.chat('❌ "' + bName + '" неизвестен')
      fullStop(); MODE = 'farm'; isMining = true
      bot.chat('⛏️ ' + count + '× ' + bName + '...')
      let got = 0, fails = 0
      while (MODE === 'farm' && got < count) {
        const blk = bot.findBlock({ matching: aliasIds, maxDistance: 100 })
        if (!blk) {
          if (++fails >= 3) { bot.chat('❌ Не найден!'); break }
          await sleep(500); continue
        }
        fails = 0
        // collectBlock: сам ищет путь, сам подбирает дроп, проверяет LOS
        const ok = await new Promise(res => bot.collectBlock.collect(blk, {}, e => res(!e)))
        if (ok) { got++; if (got % 4 === 0) bot.chat('📦 ' + got + '/' + count) }
        else await sleep(300)
      }
      isMining = false; pfStop()
      if (got >= count) bot.chat('✅ ' + got + '× ' + bName + '!')
      if (MODE === 'farm') MODE = null; return
    }

    if (msg.startsWith('!собери ')) {
      const args = low.slice(1); let bName, count = 1
      if (!isNaN(parseInt(args[0]))) { count = parseInt(args[0]); bName = args[1] } else { bName = args[0]; count = parseInt(args[1]) || 1 }
      if (!bName || !mcData) return bot.chat('❌ !собери [кол] <блок>')
      const bType = mcData.blocksByName[bName]; if (!bType) return bot.chat('❌ "' + bName + '" неизвестен')
      const blk = bot.findBlock({ matching: bType.id, maxDistance: 100 }); if (!blk) return bot.chat('❌ Нет рядом!')
      fullStop(); MODE = 'collect'; bot.chat('🌲 ' + count + '× ' + bName + '...')
      bot.collectBlock.collect(blk, { count }, err => {
        if (MODE === 'collect') MODE = null
        bot.chat(err ? '❌ ' + err.message : '✅ ' + count + '× ' + bName + '!')
      }); return
    }
    if (msg === '!стоп собирать') {
      if (['farm','collect','dig'].includes(MODE)) { MODE = null; pfStop(); try { bot.stopDigging() } catch (_) {}; bot.chat('🛑 Стоп.') }; return
    }

    // ══ ФЕРМЫ ════════════════════════════════════════════════════════
    if (msg.startsWith('!ферма ')) {
      if (!FARM_BLUEPRINTS[low[1]]) return bot.chat('❌ Типы: ' + Object.keys(FARM_BLUEPRINTS).join(', '))
      fullStop(); MODE = 'farm'; buildFarm(low[1]); return
    }

    // ══ БОЙ ══════════════════════════════════════════════════════════
    if (msg.startsWith('!атакуй ')) {
      const name = low[1]
      const tgt = bot.nearestEntity(e => e.isValid && ((e.name?.toLowerCase().includes(name)) || (e.username?.toLowerCase().includes(name))))
      if (!tgt) return bot.chat('❌ "' + name + '" не найден!')
      fullStop(); MODE = 'attack'; equipBestWeapon(); startCombat(tgt); return
    }
    if (msg === '!убей всё') {
      const mob = bot.nearestEntity(e => isHostileMob(e))
      if (!mob) return bot.chat('❌ Нет мобов!'); fullStop(); MODE = 'attack'; equipBestWeapon(); startCombat(mob); return
    }
    if (msg === '!охрана') {
      fullStop(); MODE = 'guard'; modeMeta = { pos: bot.entity.position.clone() }
      bot.chat('🛡️ Охраняю @ ' + modeMeta.pos.x.toFixed(0) + ' ' + modeMeta.pos.z.toFixed(0)); return
    }
    if (msg === '!охрана стоп') { if (MODE === 'guard') { MODE = null; stopCombat() }; bot.chat('🛡️ Выкл.'); return }

    // ── Телохранитель ─────────────────────────────────────────────
    if (msg === '!защищай меня' || msg === '!телохранитель' || msg === '!бодигард') {
      fullStop(); stopCombat()
      MODE = 'bodyguard'; modeMeta = { who: user }
      bot.chat('🛡️⚔️ Защищаю ' + user + '! Буду убивать мобов в 16 блоках от тебя.')
      return
    }
    if (msg === '!телохранитель стоп' || msg === '!защита стоп') {
      if (MODE === 'bodyguard') { fullStop(); stopCombat() }
      bot.chat('🛡️ Режим защиты выключен.'); return
    }
    if (msg === '!режим мирный')   { behaviorMode = 'мирный';   bot.chat('😇 Мирный'); return }
    if (msg === '!режим защита')   { behaviorMode = 'защита';   bot.chat('🛡️ Защита'); return }
    if (msg === '!режим агрессия') { behaviorMode = 'агрессия'; bot.chat('😤 Агрессия'); return }

    // ══ ЩИТ ══════════════════════════════════════════════════════════
    if (msg === '!щит') {
      const s = getShield(); if (!s) return bot.chat('❌ Нет щита!')
      await bot.equip(s, 'off-hand').catch(() => {}); bot.activateItem(); shieldUp = true; bot.chat('🛡️ Блок!'); return
    }
    if (msg === '!щит стоп') { bot.deactivateItem(); shieldUp = false; bot.chat('🛡️ Убрал.'); return }
    if (msg === '!автощит') {
      shieldAuto = !shieldAuto
      if (shieldAuto && !getShield()) { shieldAuto = false; return bot.chat('❌ Нет щита!') }
      bot.chat('🛡️ Автощит: ' + (shieldAuto ? '✅' : '❌')); return
    }

    // ══ БРОНЯ ════════════════════════════════════════════════════════
    if (msg === '!броня') { await equipBestArmor(); bot.chat('🛡️ Надел лучшую броню!'); return }
    if (msg === '!автоброня') { autoArmor = !autoArmor; bot.chat('🛡️ Автоброня: ' + (autoArmor ? '✅' : '❌')); return }

    // ══ ЕДА ══════════════════════════════════════════════════════════
    if (msg === '!ешь') {
      const food = bot.inventory.items().find(i => isFood(i.name)); if (!food) return bot.chat('❌ Нет еды!')
      await bot.equip(food, 'hand').catch(() => {}); await bot.consume().catch(e => bot.chat('❌ ' + e.message))
      bot.chat('🍎 HP:' + Math.round(bot.health) + ' 🍖' + Math.round(bot.food)); return
    }
    if (msg === '!автоеда') { autoEat = !autoEat; bot.chat('🍖 ' + (autoEat ? '✅' : '❌')); return }

    // ══ ИНВЕНТАРЬ ════════════════════════════════════════════════════
    if (msg === '!инв' || msg === '!инвентарь') {
      const items = bot.inventory.items(); if (!items.length) return bot.chat('📦 Пусто')
      const sum = {}; items.forEach(i => { sum[i.name] = (sum[i.name] || 0) + i.count })
      await chatLong('📦 ' + Object.keys(sum).map(n => n + '×' + sum[n]).join(' ')); return
    }
    if (msg === '!материалы') {
      const items = bot.inventory.items()
      await chatLong('📦 ' + (items.length ? items.map(i => i.name + '×' + i.count).join(' ') : 'пусто')); return
    }
    if (msg === '!выбрось всё') { for (const i of bot.inventory.items()) await bot.tossStack(i).catch(() => {}); bot.chat('🗑️ Пусто!'); return }

    // ── Выбросить мусор (всё кроме еды, оружия, брони, инструментов) ──
    if (msg === '!выбрось мусор') {
      const keep = new Set(['diamond','iron_ingot','gold_ingot','netherite_ingot','emerald',
        'coal','string','gunpowder','bone','arrow','flint'])
      const keepTypes = ['sword','axe','pickaxe','shovel','hoe','helmet','chestplate',
        'leggings','boots','shield','bow','crossbow','trident','bucket','water_bucket']
      let dropped = 0
      for (const i of bot.inventory.items()) {
        const isWeapon = keepTypes.some(t => i.name.includes(t))
        const isFoodItem = isFood(i.name)
        const isValuable = keep.has(i.name)
        if (!isWeapon && !isFoodItem && !isValuable) {
          await bot.tossStack(i).catch(() => {}); dropped++; await sleep(30)
        }
      }
      bot.chat('🗑️ Выбросил мусор: ' + dropped + ' стаков'); return
    }

    // ── Сортировка инвентаря (показать по группам) ──
    if (msg === '!сортировать') {
      const items = bot.inventory.items()
      const weapons = items.filter(i => ['sword','axe','bow','crossbow','trident'].some(t => i.name.includes(t)))
      const armor = items.filter(i => ['helmet','chestplate','leggings','boots','shield'].some(t => i.name.includes(t)))
      const food = items.filter(i => isFood(i.name))
      const tools = items.filter(i => ['pickaxe','shovel','hoe'].some(t => i.name.includes(t)))
      const other = items.filter(i => !weapons.includes(i) && !armor.includes(i) && !food.includes(i) && !tools.includes(i))
      const lines = []
      if (weapons.length) lines.push('⚔️ ' + weapons.map(i => i.name + '×' + i.count).join(', '))
      if (armor.length)   lines.push('🛡️ ' + armor.map(i => i.name).join(', '))
      if (tools.length)   lines.push('⛏️ ' + tools.map(i => i.name).join(', '))
      if (food.length)    lines.push('🍖 ' + food.map(i => i.name + '×' + i.count).join(', '))
      if (other.length)   lines.push('📦 ' + other.map(i => i.name + '×' + i.count).join(', '))
      for (const l of lines) { bot.chat(l); await sleep(300) }
      return
    }

    // ── Надеть/снять конкретную вещь ──
    if (msg.startsWith('!надеть ')) {
      const name = low.slice(1)
      const item = bot.inventory.items().find(i => i.name.includes(name))
      if (!item) { bot.chat('❌ Нет: ' + name); return }
      const slot = item.name.includes('helmet') ? 'head' : item.name.includes('chestplate') ? 'torso' :
        item.name.includes('leggings') ? 'legs' : item.name.includes('boots') ? 'feet' : 'hand'
      await bot.equip(item, slot).catch(() => {}); bot.chat('✅ Надел ' + item.name); return
    }

    // ── Количество конкретной вещи ──
    if (msg.startsWith('!сколько ')) {
      const name = low.slice(1)
      const items = bot.inventory.items().filter(i => i.name.includes(name))
      const total = items.reduce((s, i) => s + i.count, 0)
      bot.chat(total > 0 ? '📦 ' + name + ': ' + total + ' шт' : '❌ Нет ' + name); return
    }

    // ── Иди к координатам ──
    if (msg.startsWith('!хп')) {
      bot.chat('❤️ HP: ' + Math.round(bot.health) + '/20  🍖 Food: ' + Math.round(bot.food) + '/20  🎯 ' + (combatTarget ? 'В бою: ' + (combatTarget.name || combatTarget.username) : 'Не в бою')); return
    }

    // ── Покинуть бой ──
    if (msg === '!не атакуй' || msg === '!мир') { stopCombat('🕊️ Прекратил бой'); return }

    // ── Прыгнуть ──
    if (msg === '!прыгни') {
      bot.setControlState('jump', true)
      setTimeout(() => bot.setControlState('jump', false), 300)
      bot.chat('🦘'); return
    }

    // ── Присесть/встать ──
    if (msg === '!присядь' || msg === '!сядь') {
      bot.setControlState('sneak', true); bot.chat('🦆 Сел'); return
    }
    if (msg === '!встань') {
      bot.setControlState('sneak', false); bot.chat('🧍 Встал'); return
    }

    // ── Спринт вкл/выкл ──
    if (msg === '!бег вкл') { bot.setControlState('sprint', true); bot.chat('🏃 Спринт!'); return }
    if (msg === '!бег выкл') { bot.setControlState('sprint', false); bot.chat('🚶 Пешком'); return }

    // ── Смотреть на игрока ──
    if (msg === '!смотри на меня') {
      const ent = bot.players[user]?.entity
      if (!ent) { bot.chat('❌ Не вижу тебя'); return }
      await bot.lookAt(ent.position.offset(0, 1.62, 0), true)
      bot.chat('👀 Смотрю!'); return
    }

    // ── Покормить ──
    if (msg === '!поешь') {
      if (bot.food >= 20) { bot.chat('🍖 Сыт!'); return }
      const food = bot.inventory.items().find(i => isFood(i.name))
      if (!food) { bot.chat('❌ Нет еды'); return }
      await bot.equip(food, 'hand'); await bot.consume().catch(() => {})
      bot.chat('😋 Поел!'); return
    }

    // ── Починить (показать что сломано) ──
    if (msg === '!что сломано') {
      const damaged = bot.inventory.items().filter(i => i.durabilityUsed && i.durabilityUsed > 0)
      if (!damaged.length) { bot.chat('✅ Всё целое!'); return }
      bot.chat('🔧 Сломано: ' + damaged.map(i => i.name + ' (' + i.durabilityUsed + '/' + i.maxDurability + ')').join(', ')); return
    }

    // ── Выбросить в сторону игрока ──
    if (msg.startsWith('!дай ')) {
      const name = low.slice(1)
      const item = bot.inventory.items().find(i => i.name.includes(name))
      if (!item) { bot.chat('❌ Нет: ' + name); return }
      const ent = bot.players[user]?.entity
      if (ent) {
        pfGo(new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2))
        await waitFor(() => bot.entity.position.distanceTo(ent.position) < 3, 5000).catch(() => {})
        pfStop(); if (MODE === 'goto') MODE = null
      }
      await bot.tossStack(item).catch(() => {})
      bot.chat('🎁 Держи ' + item.name + '!'); return
    }

    if (msg.startsWith('!выбрось ')) {
      const it = bot.inventory.items().find(i => i.name.includes(low[1])); if (!it) return bot.chat('❌ Нет!')
      await bot.toss(it.type, null, Math.min(parseInt(low[2]) || 64, it.count)); bot.chat('🗑️ ' + it.name); return
    }
    if (msg.startsWith('!экипируй ')) {
      const it = bot.inventory.items().find(i => i.name.includes(low[1])); if (!it) return bot.chat('❌ Нет!')
      await bot.equip(it, low[2] || 'hand').catch(e => bot.chat('❌ ' + e.message)); bot.chat('🔧 ' + it.name); return
    }
    if (msg.startsWith('!есть ')) {
      const found = bot.inventory.items().filter(i => i.name.includes(low[1]))
      bot.chat(found.length ? '🔍 ' + found.map(i => i.name + '×' + i.count).join(', ') : '❌ Нет'); return
    }

    // ══ СУНДУК ═══════════════════════════════════════════════════════
    if (msg.startsWith('!сундук ')) {
      if (low[1] === 'проверить')   await chestAction('проверить')
      else if (low[1] === 'положить') await chestAction('положить', low[2], parseInt(low[3]) || 64)
      else if (low[1] === 'взять')    await chestAction('взять',    low[2], parseInt(low[3]) || 1)
      else if (low[1] === 'скинь' || low[1] === 'дай') {
        // !сундук скинь [предмет] [кол] — взять из сундука и выбросить игроку
        await giveFromChest(low[2] || 'всё', parseInt(low[3]) || 0, user)
      }
      return
    }

    // ══ КРАФТ ════════════════════════════════════════════════════════
    if (msg.startsWith('!крафт ') || msg.startsWith('!сделай ')) { await smartCraft(low[1], parseInt(low[2]) || 1); return }
    if (msg.startsWith('!крафт+дай ')) { await craftAndGive(low[1], parseInt(low[2]) || 1, user); return }
    if (msg.startsWith('!печка '))     { await smeltItem(low[1], parseInt(low[2]) || 1); return }
    if (msg.startsWith('!зелье '))     { await brewPotion(low[1]); return }
    if (msg.startsWith('!зачаровать ')) { await enchantItem(low[1]); return }

    // ══ СТАТУС ═══════════════════════════════════════════════════════
    if (msg === '!статус' || msg === '!инфо') {
      const p = bot.entity.position
      bot.chat((bot.vehicle ? '🚤' : '🚶') + ' ❤️' + Math.round(bot.health) + '/20 🍖' + Math.round(bot.food) + '/20 📍' +
        p.x.toFixed(0) + ' ' + p.y.toFixed(0) + ' ' + p.z.toFixed(0) + ' MODE:' + (MODE || 'idle') + ' [' + behaviorMode + ']'); return
    }
    if (msg === '!где') { const p = bot.entity.position; bot.chat('📍 ' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ' + p.z.toFixed(1)); return }
    if (msg.startsWith('!где ') && low[1]) {
      const pl = bot.players[low[1]]?.entity; if (!pl) return bot.chat('❌ ' + low[1] + ' не виден!')
      bot.chat('📍 ' + low[1] + ': ' + pl.position.x.toFixed(0) + ' ' + pl.position.y.toFixed(0) + ' ' + pl.position.z.toFixed(0) + ' [' + Math.round(bot.entity.position.distanceTo(pl.position)) + 'м]'); return
    }
    if (msg.startsWith('!дист ') && low[1]) {
      const pl = bot.players[low[1]]?.entity; if (!pl) return bot.chat('❌ Нет!')
      bot.chat('📏 ' + Math.round(bot.entity.position.distanceTo(pl.position)) + 'м до ' + low[1]); return
    }
    if (msg === '!игроки') {
      const list = Object.keys(bot.players).filter(n => n !== bot.username)
      bot.chat(list.length ? '👥 ' + list.join(', ') : '👥 Никого.'); return
    }
    if (msg === '!пинг')   { bot.chat('📶 ' + (bot.player?.ping ?? '?') + 'мс'); return }
    if (msg === '!время')  { const t = bot.time.timeOfDay; bot.chat('🕐 ' + t + ' ' + (t < 13000 ? '☀️' : '🌙')); return }
    if (msg === '!погода') { bot.chat(bot.isRaining ? '🌧️ Дождь' : '☀️ Ясно'); return }
    if (msg === '!что под') { const b = bot.blockAt(bot.entity.position.offset(0, -1, 0)); bot.chat('🧱 ' + (b?.name ?? 'воздух')); return }
    if (msg.startsWith('!найди ') && low[1]) {
      if (!mcData) return bot.chat('❌ Не готов')
      const bType = mcData.blocksByName[low[1]]; if (!bType) return bot.chat('❌ Неизвестен')
      const blk = bot.findBlock({ matching: bType.id, maxDistance: 100 }); if (!blk) return bot.chat('❌ Нет рядом!')
      bot.chat('🔍 ' + low[1] + ': ' + blk.position.x + ' ' + blk.position.y + ' ' + blk.position.z + ' [' + Math.round(bot.entity.position.distanceTo(blk.position)) + 'м]'); return
    }

    // ══ ПАТРУЛЬ ══════════════════════════════════════════════════════
    if (msg === '!патруль добавь') { const p = bot.entity.position; patrolPoints.push({ x: p.x, y: p.y, z: p.z }); bot.chat('📍 #' + patrolPoints.length + ': ' + p.x.toFixed(0) + ' ' + p.z.toFixed(0)); return }
    if (msg === '!патруль старт') {
      if (patrolPoints.length < 2) return bot.chat('❌ Нужно 2+ точек')
      fullStop(); MODE = 'patrol'; patrolIdx = 0; pfGo(new goals.GoalNear(patrolPoints[0].x, patrolPoints[0].y, patrolPoints[0].z, 2))
      bot.chat('🔄 ' + patrolPoints.length + ' точек'); return
    }
    if (msg === '!патруль стоп') { if (MODE === 'patrol') MODE = null; pfStop(); bot.chat('🛑'); return }
    if (msg === '!патруль очисти') { patrolPoints = []; bot.chat('🗑️ Очищены.'); return }
    if (msg === '!патруль список') {
      if (!patrolPoints.length) return bot.chat('Нет.')
      bot.chat(patrolPoints.map((p, i) => (i+1) + ':(' + p.x.toFixed(0) + '/' + p.z.toFixed(0) + ')').join(' ').slice(0, 250)); return
    }

    // ══ AFK ══════════════════════════════════════════════════════════
    if (msg === '!афк') { if (MODE === 'afk') { MODE = null; bot.chat('✅ AFK выкл.') } else { fullStop(); MODE = 'afk'; bot.chat('💤 AFK вкл.') }; return }
    if (msg === '!антиафк') { antiAfk = !antiAfk; bot.chat('🤖 Анти-АФК: ' + (antiAfk ? '✅' : '❌')); return }

    // ══ ЧАТ ══════════════════════════════════════════════════════════
    if (msg.startsWith('!скажи '))   { bot.chat(raw.slice(7)); return }
    if (msg.startsWith('!шепни '))   { if (!tok[2]) return bot.chat('❌ !шепни <ник> <текст>'); bot.chat('/msg ' + tok[1] + ' ' + tok.slice(2).join(' ')); return }
    if (msg.startsWith('!команда ')) { bot.chat('/' + raw.slice(9)); return }

    // ══ ПОМОЩЬ ════════════════════════════════════════════════════════
    if (msg === '!помощь' || msg === '!команды') { await showHelp(); return }
  })

  // ════════════════════════════════════════════════════════════════
  //  СОБЫТИЯ
  // ════════════════════════════════════════════════════════════════
  bot.on('health', () => {
    if (bot.health <= 4 && !eatingNow) {
      const food = bot.inventory.items().find(i => isFood(i.name))
      if (food) {
        eatingNow = true
        bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {}).finally(() => { eatingNow = false })
      }
    }
  })

  // Подобрали предмет → проверить броню
  bot.on('playerCollect', collector => {
    if (collector !== bot.entity) return
    if (autoArmor) setTimeout(() => equipBestArmor(), 500)
  })

  // Контр-атака при получении урона
  // Щит сломан — восстанавливаем как только появится новый
  bot.on('entityEquipmentChange', (entity, slot, newItem) => {
    if (entity !== bot.entity) return
    if (slot !== 'offhand') return
    // Если offhand стал пустым (щит сломан или снят)
    if (!newItem || !newItem.name.includes('shield')) {
      shieldUp = false
      // Через 200мс пробуем снова экипировать щит
      setTimeout(() => {
        if (!combatTarget && !shieldAuto) return
        const s = getShield()
        if (s) bot.equip(s, 'off-hand').then(() => { activateOffhand(); shieldUp = true }).catch(() => {})
      }, 200)
    }
  })

  let _entityHurtCooldown = 0
  bot.on('entityHurt', entity => {
    if (!bot.entity) return
    // Если ударили НАШЕГО бота
    if (entity === bot.entity) {
      if (behaviorMode === 'мирный' || combatTarget) return
      if (Date.now() - _entityHurtCooldown < 2000) return

    const myPos = bot.entity.position
    let closest = null, closestDist = 10

    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (!e || !e.isValid || e === bot.entity || !e.position) continue
      const d = e.position.distanceTo(myPos)
      if (d >= closestDist) continue

      // И защита и агрессия — только мобы (isHostileMob)
      // Агрессия отличается только радиусом auto-combat (16 vs 8 блоков)
      if (isHostileMob(e)) { closest = e; closestDist = d }
    }

    if (closest) { equipBestWeapon(); startCombat(closest) }
    }
    // Если ударили МОБА — добавляем в цель (агрессия/защита)
    if (entity !== bot.entity && isHostileMob(entity) && !combatTarget && behaviorMode !== 'мирный') {
      if (entity.position.distanceTo(bot.entity.position) < 16) {
        equipBestWeapon(); startCombat(entity)
      }
    }
  })

  bot.on('death', () => {
    console.log('💀 Умер')
    isDead = true
    // Сбрасываем ВСЁ
    MODE = null; modeMeta = {}
    combatTimer = null
    combatTarget = null; shieldUp = false; axeMode = false
    tridentMode = false; bowMode = false; bowCharging = false
    isMining = false; isWaterDropping = false; eatingNow = false
    bot.clearControlStates()
    try { bot.pathfinder.setGoal(null) } catch (_) {}
  })

  // Возрождение — сбрасываем флаг и восстанавливаем движения
  bot.on('respawn', () => {
    console.log('♻️ Возродился')
    isDead = false
    MODE = null; modeMeta = {}
    combatTarget = null
    try { bot.pathfinder.setGoal(null) } catch (_) {}
    setTimeout(() => applyMovements(), 500)
  })
  bot.on('error',  e  => console.error('❌', e.message))
  bot.on('kicked', r  => console.log('🔴 Кик:', r))
  bot.on('end',    () => { restoreDoorBoundingBoxes(); console.log('🔌 Реконнект 5с...'); setTimeout(createBot, 5000) })

  process.stdin.removeAllListeners('data')
  process.stdin.on('data', d => { const t = d.toString().trim(); if (t) bot.chat(t) })
}

createBot()
