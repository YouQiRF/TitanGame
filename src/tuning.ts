/**
 * 全遊戲數值集中管理。
 *
 * 手感調整一律改這裡，不要散落到各系統檔案裡。
 * 單位：距離 px、時間 s、速度 px/s、角度 rad。
 */

export const T = {
  /**
   * 競技場（世界座標，左上角為 0,0）。
   * 刻意偏小：走位空間越緊，體力管理越吃重，Boss 也更快撞到牆。
   */
  arena: {
    w: 1100,
    h: 820,
    wallThickness: 22,
  },

  player: {
    radius: 14,
    /** 地面移動速度 */
    speed: 235,
    /** 加速 / 煞車的趨近率，數字越大越靈敏（越沒有慣性） */
    accel: 18,

    maxHp: 100,
    maxStamina: 100,
    /**
     * 體力回復。沒有獨立翻滾後，體力只被斬擊消耗——
     * 比原本「滿力斬 64 + 一次翻滾 25」的體力經濟寬鬆很多，數字尚未依此重新驗證。
     */
    staminaRegen: 25,
    /** 消耗體力後，要等這麼久才開始回復 */
    staminaRegenDelay: 0.58,

    /** 受擊後的無敵時間 */
    hurtIFrame: 0.7,
    /** 受擊後被擊退的初速 */
    hurtKnockback: 260,
  },

  /**
   * 斬擊：長按左鍵進入子彈時間瞄準，放開執行。
   * 距離越遠 → 傷害越高、體力消耗越高。這是本作的核心風險/回報抉擇。
   *
   * 沒有獨立的翻滾/閃避鍵——斬擊位移期間的無敵幀就是唯一的閃避手段。
   * 因此 `iFrameEnd`/`minCost`/`bulletTimeBlend` 都比原本翻滾存在時調得更寬鬆，
   * 讓短距離的「防禦性斬擊」划算、能快速反應，堪用當緊急閃避。
   */
  slash: {
    /** 瞄準時的時間縮放（世界變慢，玩家瞄準仍即時） */
    bulletTimeScale: 0.16,
    /** 進入 / 離開子彈時間的過渡時間，調快讓按下瞄準時更快進入慢動作，反應更即時 */
    bulletTimeBlend: 0.06,

    /**
     * 蓄力取消區半徑。
     * 放開左鍵時，若游標落在角色周圍這個範圍內 → **不出刀、不耗體力**。
     * 必須小於 minDist，否則會和「最小距離斬擊」的判定重疊。
     */
    cancelRadius: 48,

    minDist: 60,
    maxDist: 300,
    minDmg: 14,
    maxDmg: 60,
    /** 調低，讓最短距離的「防禦性一斬」便宜到緊急時捨得用 */
    minCost: 8,
    maxCost: 64,

    /** 斬擊位移的持續時間（越短越銳利） */
    duration: 0.13,
    /** 斬擊命中判定的半徑（軌跡線段外擴） */
    hitRadius: 26,
    /** 斬完後的硬直 */
    recovery: 0.1,

    /**
     * 位移期間的無敵區間（佔 duration 的比例）。
     * 斬擊是「穿過去」而不是「站著砍」，所以幾乎全程無敵，
     * 但收尾段會解除——收招的瞬間仍然會被打到。
     * iFrameEnd 調寬（原 0.86），因為斬擊現在是唯一的閃避手段。
     */
    iFrameStart: 0.0,
    iFrameEnd: 0.92,

    /**
     * 瞄準模式：
     *  'cursor' = 朝游標方向斬，距離 = 角色到游標的距離（直覺、回饋最清楚）
     *  'drag'   = 朝「按下點 → 目前游標」的拖曳向量斬，距離 = 拖曳長度
     */
    aimMode: 'cursor' as 'cursor' | 'drag',
  },

  /** 第一隻 Boss：石之守衛 */
  guardian: {
    radius: 60,
    maxHp: 820,

    /** 核心（弱點）相對於 Boss 中心、沿面向方向的前方偏移 */
    coreOffset: 30,
    coreRadius: 20,
    /** 打身體（沒打中任何部位）的傷害倍率 */
    bodyMult: 0.12,
    /** 打暴露核心的傷害倍率 */
    coreMult: 2.0,

    /** 待機時朝玩家逼近的速度 */
    walkSpeed: 120,
    /** 出招之間的間隔 */
    idleTime: 0.8,

    /** 部位被破壞時 Boss 的踉蹌硬直（核心不會暴露，但可自由輸出） */
    staggerTime: 0.95,

    /** ── 招式 1：衝撞 ── */
    chargeTelegraph: 0.56,
    chargeSpeed: 950,
    chargeMaxTime: 1.15,
    chargeDamage: 32,
    /** 撞牆後的硬直（核心暴露的黃金輸出期） */
    stunTime: 2.2,

    /** ── 招式 2：砸地 ── */
    slamTelegraph: 0.5,
    slamRadius: 185,
    slamDamage: 26,
    slamRecover: 0.9,
    shockwaveSpeed: 470,
    shockwaveMaxRadius: 400,
    shockwaveDamage: 15,
    shockwaveWidth: 30,

    /** ── 招式 3：橫掃（近距離、快、範圍廣） ── */
    sweepTelegraph: 0.36,
    sweepDuration: 0.2,
    sweepRadius: 155,
    /** 扇形半角 */
    sweepHalfAngle: 1.05,
    sweepDamage: 24,
    sweepRecover: 0.52,

    /** ── 招式 4：投石（破壞 1 個部位後解鎖） ── */
    throwTelegraph: 0.52,
    throwCount: 2,
    throwInterval: 0.24,
    boulderSpeed: 560,
    boulderRadius: 17,
    boulderBlastRadius: 90,
    boulderDamage: 21,
    throwRecover: 0.58,

    /** ── 招式 5：三連踏（破壞 1 個部位後解鎖） ── */
    stompTelegraph: 0.34,
    stompCount: 3,
    stompRadius: 115,
    stompDamage: 21,
    stompInterval: 0.3,
    stompWarn: 0.3,
    stompRecover: 0.66,

    /** ── 招式 6：地裂（破壞 2 個部位後解鎖） ── */
    quakeTelegraph: 0.68,
    quakeCracks: 9,
    quakeSpeed: 600,
    quakeMaxLen: 720,
    quakeHalfAngle: 0.17,
    quakeDamage: 23,
    quakeRecover: 0.85,

    /** ── 招式 7：狂暴連撞（破壞 3 個部位後解鎖的發狂技） ── */
    rampageTelegraph: 0.4,
    rampageDashes: 3,
    rampageSpeed: 1080,
    rampageDashTime: 0.3,
    rampageGap: 0.15,
    rampageDamage: 30,
    rampageRecover: 1.15,

    /**
     * ── 招式 8：普攻（拳擊連段）── 近戰基礎攻擊：兩記快速直拳（圓形）+ 蓄力重擊（圓形，範圍更大）。
     * 前搖短、節奏快，跟其他長讀招的特殊招式做節奏對比；出招權重不受「避免連續同招」懲罰，
     * 可以連續使用，呼應「普攻可以相接」。
     */
    punchTelegraph: 0.2,
    punchInterval: 0.16,
    punchRadius: 62,
    punchReach: 58,
    punchDamage: 13,
    /** 兩拳打完後蓄力的重擊，一樣是原地正前方、範圍更大更痛 */
    heavyTelegraph: 0.55,
    heavyRadius: 95,
    heavyReach: 65,
    heavyDamage: 32,
    heavyRecover: 0.75,

    /** 距離大於此值時傾向用衝撞，否則近戰招 */
    chargePreferDist: 300,
    /** 近戰招（橫掃）的偏好距離上限 */
    meleePreferDist: 195,

    /** 血量低於此比例時出招間隔略為縮短（保底加壓，主要壓力仍來自 rage） */
    lowHpThreshold: 0.35,
    lowHpIdleMult: 0.86,

    /**
     * 可破壞部位。
     *  angle 為相對 Boss 面向的角度（0 = 正前方，π = 正後方）
     *  dist  為離 Boss 中心的距離
     *  integrity 累積受到的斬擊傷害達此值即被破壞
     *  dmgMult 打這個部位時，本體 HP 受到的傷害倍率
     */
    parts: {
      /** 核心護甲：破壞後核心永久暴露——回報最高，但也讓 Boss 最憤怒 */
      coreShell: {
        label: '核心護甲',
        angle: 0,
        dist: 30,
        radius: 25,
        integrity: 300,
        dmgMult: 0.3,
      },
      armL: {
        label: '左臂',
        angle: -1.15,
        dist: 60,
        radius: 27,
        integrity: 155,
        dmgMult: 0.5,
      },
      armR: {
        label: '右臂',
        angle: 1.15,
        dist: 60,
        radius: 27,
        integrity: 155,
        dmgMult: 0.5,
      },
      legs: {
        label: '腿部',
        angle: Math.PI,
        dist: 48,
        radius: 30,
        integrity: 185,
        dmgMult: 0.45,
      },
    },

    /** 破壞部位時額外對本體造成的傷害 = 該部位 integrity × 此值 */
    partBreakBonusDamage: 0.18,

    /**
     * 已破壞部位留下的「裸露傷口」傷害倍率。
     *
     * 這是憤怒系統的平衡對重：拆部位會讓 Boss 更強，
     * 但拆開的地方會變成永久弱點——玩家因此換到一個穩定的輸出點，
     * 不必再只靠「誘導撞牆」那個稀有的核心窗口。
     *
     * 略低於核心的 2.0，讓核心仍是回報最高的目標。
     */
    brokenPartMult: 1.6,

    /**
     * ── 憤怒（rage）── 每破壞一個部位提升一級，共 0..4 級。
     *
     * 破壞部位不會削弱 Boss，反而會激怒牠：更快、更痛、招式更多。
     * 這讓「拆部位」變成真正的抉擇，而不是無腦收益：
     * 你用傷害換來的優勢（尤其是核心永久暴露），代價是一隻更難纏的守衛。
     */
    rage: {
      /** 每級提升的攻擊傷害倍率 */
      damagePerLevel: 0.2,
      /** 每級提升的移動 / 衝撞速度倍率 */
      speedPerLevel: 0.13,
      /** 每級縮短的預警時間比例（上限 0.55，保證預警不會短到看不見） */
      telegraphCutPerLevel: 0.1,
      telegraphCutMax: 0.42,
      /** 每級縮短的出招間隔比例 */
      idleCutPerLevel: 0.14,
      idleCutMax: 0.52,
      /** 每級縮短的撞牆硬直比例（輸出窗口越來越短） */
      stunCutPerLevel: 0.09,
      stunCutMax: 0.34,

      /** 招式解鎖門檻（已破壞的部位數） */
      unlockThrow: 1,
      unlockStomp: 1,
      unlockQuake: 2,
      unlockRampage: 3,
    },
  },

  /**
   * 第二隻 Boss：傀儡師。
   *
   * 和石之守衛完全相反的命中模型：沒有部位、沒有核心倍率，
   * 打到本體就是全額傷害（bodyMult 1.0）。難度來自「打得到」而不是「打得對」。
   *
   * 核心玩法（#012 全面重做）：玩家要靠斬擊的位移無敵幀，在她壓縮出的危險地面裡
   * 穿梭到安全點，一路逼近本體——斬擊是唯一的閃避＋前進手段。場上會有「特殊傀儡」
   * （見 `special`）：不攻擊、玩家靠近會延遲爆炸，但被斬中會回復體力，
   * 把斬擊變成同時兼顧移動/閃避/輸出/資源回收的單一動作。
   */
  puppeteer: {
    radius: 24,
    maxHp: 680,
    /** 打中本體的傷害倍率——沒有部位系統，斬擊算出多少就是多少 */
    bodyMult: 1.0,
    /** 依階段提升的攻擊傷害倍率，呼應「每個階段更具進攻性」 */
    dmgMultByPhase: [1, 1.15, 1.3] as [number, number, number],

    /**
     * 待機時持續給玩家壓力：只有近到幾乎貼臉才會後退，其餘任何距離都在逼近——
     * 遠了全速追上來，近了也用較慢的速度持續貼近（而不是呆站），
     * 讓玩家隨時都感覺得到她在往自己身上壓。
     */
    kiteSpeed: 150,
    /** 只有近到這個距離內才會後退（幾乎是貼臉距離，不是主動迴避戰鬥） */
    retreatDist: 80,
    /** 超過這個距離才用全速逼近，再近一點則用 creepSpeedMult 的慢速持續貼近 */
    approachDist: 260,
    approachSpeed: 190,
    /** 交戰距離內持續貼近的速度倍率（相對 approachSpeed），太快會顯得毛躁 */
    creepSpeedMult: 0.4,

    /** 出招間隔基準值，依階段乘上 idleTimeMultByPhase 遞減——調低讓她的攻擊慾更強、節奏更緊 */
    idleTime: 0.5,
    idleTimeMultByPhase: [1, 0.8, 0.62] as [number, number, number],

    /** 階段門檻（血量比例）。0..2 三個階段，越低越具攻擊性 */
    phase2Hp: 0.66,
    phase3Hp: 0.33,

    /**
     * ── 破綻 ──
     * 每連續出招達到這個次數，她會有一段明顯更長、完全靜止的破綻，
     * 而不是每次出招後都立刻恢復戒備——玩家需要「等到」而不是「隨時都行」，
     * 但這個窗口一定會來，攻擊慾強不代表無懈可擊。
     */
    opening: {
      every: 2,
      duration: 1.1,
    },

    /**
     * ── 特殊傀儡 ──
     * 貫穿全部招式的核心機制：不攻擊，玩家靠近會延遲爆炸，但被斬中會回復體力。
     * 把「斬擊」變成同時兼顧移動/閃避/輸出/資源回收的單一動作。
     */
    special: {
      radius: 22,
      /** 玩家進入這個距離內，引信開始累積 */
      triggerRadius: 75,
      /** 引信累積滿這個秒數就爆炸 */
      fuseTime: 0.85,
      /** 玩家離開觸發範圍後，引信衰退的速度倍率（比累積快，不是瞬間歸零） */
      fuseDecayMult: 1.8,
      explodeRadius: 100,
      explodeDamage: 26,
      /** 被斬中時回復的體力 */
      staminaRestore: 42,
      /**
       * 沒被斬到也沒炸到的話，這麼久之後會自己消失——避免玩家一直不理它們，
       * 場上越堆越多隻。比 `gauntlet.duration`(6.5s) 短，招式c 走廊上的特殊傀儡
       * 可能在安全逾時前就先自己消失，這是刻意的：逼玩家不要慢慢摸再過去。
       */
      life: 5,
    },

    /**
     * ── 招式 a：放射狀路徑（全程可用）── 本體向外打出等角度間隔的路徑，路徑間隙藏特殊傀儡。
     * 角度在選招當下就鎖定（`Puppeteer.radialBaseAngle`），預警畫的就是最終會出現的路徑，
     * 不是等 telegraph 結束才重新隨機——telegraph 拉長到 0.7s，給玩家足夠的反應時間。
     */
    radial: {
      telegraph: 0.7,
      rayCount: 6,
      /** 每條路徑的命中半寬（線段判定用） */
      rayHalfWidth: 24,
      /** 路徑從 0 長到滿的時間 */
      rayGrow: 0.2,
      rayLength: 950,
      /** 長滿之後還會持續多久才消失 */
      holdTime: 1.1,
      damage: 20,
      /** 每個路徑間隙裡，特殊傀儡離本體的距離 */
      specialDist: 240,
      recover: 0.6,
    },

    /**
     * ── 招式 b：前撲扇形 + 後跳 + 留特殊傀儡（全程可用，基本招）──
     * 前搖短、單次判定、低風險，用來自然教會玩家「特殊傀儡可以斬」這件事。
     * 出招權重不受「避免連續同招」懲罰，可以連續使用。
     */
    lunge: {
      telegraph: 0.24,
      halfAngle: 0.55,
      radius: 105,
      damage: 18,
      hopDistance: 100,
      hopDuration: 0.2,
      recover: 0.5,
    },

    /**
     * ── 招式 b'：前撲扇形，不後跳（全程可用，另一種基本招）──
     * 跟招式b 同樣是低風險的近戰基本招，差別是打完直接收招、留在原地不撤——
     * 換來的是不必重新欺身就能繼續輸出，跟招式b「打了就跑、留一份回體力的獎勵」互補。
     * 同樣不受「避免連續同招」懲罰，可以連續使用。
     */
    press: {
      telegraph: 0.24,
      halfAngle: 0.55,
      radius: 105,
      damage: 18,
      recover: 0.55,
    },

    /**
     * ── 招式 e：小型旋轉環（階段1解鎖）──
     * 原地召喚一圈公轉危險物（比招式d 小、少、短），其中一格是特殊傀儡——
     * 在正式面對招式d 之前，先讓玩家練習「抓時機貼近旋轉中的特殊傀儡」這個技巧。
     */
    spin: {
      unlockPhase: 1,
      telegraph: 0.4,
      ringRadius: 140,
      ringCount: 5,
      ringSpeed: 2.0,
      ringDamage: 16,
      ringDuration: 3.0,
      recover: 0.6,
    },

    /**
     * ── 招式 c：傳送到玩家對面 + 全場穿越 + 暈眩（階段2解鎖）──
     * 傳送到「玩家位置以競技場中心鏡射」的位置，灑一批原地脈衝傀儡鋪滿全場，
     * 只留 `corridorCount` 條安全走廊（其中一條保證是本體→玩家的最短直線），
     * 走廊上擺特殊傀儡。玩家在這招期間打中本體 → 暈眩她幾秒，是整場最大的保底輸出窗口。
     */
    gauntlet: {
      unlockPhase: 2,
      telegraph: 0.5,
      /**
       * 傳送完到危險場地正式啟動之間的緩衝，讓玩家先看清楚走廊在哪——
       * 走廊角度傳送當下就鎖定（`computeGauntletCorridors()`），這段時間看到的預覽是真的，
       * 不是裝飾，拉長到 0.6s 給足反應時間。
       */
      fieldDelay: 0.6,
      /** 安全逾時：這麼久沒打到本體就自動收招，避免卡關 */
      duration: 6.5,
      corridorCount: 2,
      /** 走廊的角度半寬，越大越好走但越不緊張 */
      corridorHalfAngle: 0.34,
      /** 場地網格間距，決定脈衝傀儡的密度 */
      gridSpacing: 140,
      pulseInterval: 0.85,
      pulseRadius: 55,
      pulseDamage: 15,
      /** 每條走廊放幾隻特殊傀儡 */
      specialPerCorridor: 2,
      stunDuration: 2.6,
      recover: 0.8,
    },

    /**
     * ── 招式 d：中心推牆 + 旋轉環（階段2解鎖，最終階段開場強制招）──
     * 跳到場地中心，先一發擊退把玩家推開，接著召喚一圈繞著本體旋轉的傀儡，
     * 其中一個位置放會公轉的特殊傀儡——抓時機貼近它，藉機欺身。
     */
    center: {
      unlockPhase: 2,
      telegraph: 0.5,
      pushDamage: 12,
      pushRadius: 260,
      ringRadius: 210,
      ringCount: 8,
      /** 公轉角速度（rad/s） */
      ringSpeed: 1.6,
      ringDamage: 18,
      ringDuration: 5.0,
      /** 每個公轉危險物的命中半徑 */
      hazardRadius: 24,
      recover: 0.8,
    },

    /**
     * ── 終局處決（全場僅觸發一次）──
     * 最終階段（phase 2）血量跌到「階段內剩一半」（`phase3Hp / 2`）時強制觸發，
     * 觸發後 hp 鎖住不再往下掉（見 `Puppeteer.applyDamage()`）。跳到場地中心，
     * 把玩家直線推到牆邊，全場鋪滿危險物只留一串安全圓——相鄰安全圓的間距
     * 控制在斬擊可達範圍內（`stepDist` 略小於 `T.slash.maxDist`(300) 留餘裕），
     * 一路斬過去終究打得到本體。**沒有時間限制**，打中本體就會處決她、直接獲勝。
     */
    execute: {
      /** 觸發時機：最終階段血量範圍的一半（phase3Hp / 2） */
      triggerHpRatio: 0.165,
      telegraph: 0.4,
      /** 安全圓之間的步距 */
      stepDist: 210,
      /** 步進時左右隨機偏移的最大幅度，避免路徑呆板成一直線 */
      jitter: 70,
      safeRadius: 85,
      /** 鋪滿全場的脈衝傀儡間距／攻擊參數 */
      gridSpacing: 120,
      pulseInterval: 0.7,
      pulseRadius: 55,
      pulseDamage: 18,
      /** 安全圓內特殊傀儡與危險物的存活時間——這招沒有時間限制，設近乎無限 */
      infiniteLife: 99999,
      /** 命中後她整個定格多久才真正死亡，main.ts 的處決演出時間要略長於這個值 */
      deathDelay: 0.5,
      /** main.ts 用：處決演出總長（比 deathDelay 長，留出鏡頭拉回的尾段） */
      cinematicTime: 1.0,
      /** main.ts 用：演出期間鏡頭放大的峰值倍率（乘在 Camera.zoom 上） */
      cinematicZoomPeak: 1.9,
      /** main.ts 用：演出期間強制壓到的時間縮放，比一般子彈時間更慢 */
      cinematicTimeScale: 0.06,
    },
  },

  /**
   * 觸控操作（手機 / 平板）。
   * 只有偵測到第一次觸控後才會生效，桌機的鍵鼠手感完全不受影響。
   *
   * 觸控的瞄準一律走「拖曳」而不是「游標」：手指按在哪裡不重要，
   * 只看往哪個方向拖、拖了多遠——否則手指自己會擋住要斬的目標，
   * 而且左半屏被搖桿佔走之後根本沒辦法往左瞄。
   */
  touch: {
    /** 虛擬搖桿底座半徑（CSS 像素）；旋鈕推到這個距離就等同滿舵 */
    stickRadius: 54,
    /** 搖桿死區：位移小於這個值視為沒有輸入，避免手指微顫就開始走 */
    stickDeadzone: 9,

    /**
     * 拖到「最遠一斬」所需的長度 = min(視窗寬, 高) × 這個比例，
     * 再夾在下面的上下限之間。拇指舒適的行程大約就是螢幕短邊的 1/4。
     */
    maxDragFraction: 0.26,
    maxDragMin: 84,
    maxDragMax: 190,

    /** 閒置時的操作提示圈距離螢幕邊角的內縮（CSS 像素） */
    hintInset: 92,
  },

  camera: {
    /** 跟隨玩家的趨近率 */
    followRate: 7,
    /** 鏡頭朝游標方向前瞻的比例（0 = 完全跟角色） */
    lookAhead: 0.16,
    lookAheadMax: 110,
    /**
     * 縮放後任一軸最多顯示場地的比例——玩家看不到全地圖，
     * 逼玩家更依賴讀圖／記位置。Boss 因此可能從畫面外攻擊，
     * 需要搭配場外提示（見 ui/hud.ts 的 drawOffscreenBossIndicator）。
     */
    visibleFraction: 0.575,
  },
} as const;
