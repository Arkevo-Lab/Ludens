/* Shared by the Electron main process and the companion's classic browser scripts. */
const companionI18n = {
  en: {
    lang: 'en', name: 'Ludens', console: 'Ludens Console',
    petLabel: 'Ludens: click to interact, drag to move, right-click for settings and games',
    petTitle: 'Click to interact · Drag to move · Right-click for games & settings',
    details: 'Details', dismiss: 'Dismiss', dismissLabel: 'Dismiss this activity',
    lines: ['I’m here.', 'Look first, then act.', 'Hmm? The name’s Ludens.', 'Enough poking. I’m thinking.', 'I’ve got this. Probably.', 'Even spider legs need a break.', 'One more try.', 'Shall we take a look together?'],
    activity: {
      running: 'Running', error: 'Error', complete: 'Done', generating: 'Generating',
      content: '{title} content, scrollable', arguments: 'Arguments', result: 'Result',
      aiControl: 'AI has control', manualControl: 'Control returned to you',
      waiting: 'Connected, waiting for AI to take control', returned: 'Run finished; control returned to you',
    },
    menu: {
      open: 'Open Ludens Console', quit: 'Quit Ludens', play: 'Play · Catch the Stars',
      poses: 'Pose', automatic: 'Automatic (activity and idle)', effects: 'Effect', none: 'None',
      hide: 'Hide pet', show: 'Show pet', size: 'Size', small: 'Small', medium: 'Medium', large: 'Large',
      categories: { '日常': 'Everyday', '工作': 'Work', '互动': 'Interaction', '方向': 'Movement', '特色': 'Special', '特效': 'Effects' },
    },
    game: {
      label: 'Catch the Stars', target: 'Catch the star', goal: 'Catch 10 stars in 20 seconds',
      win: 'Star catcher!', lose: 'So close! One more round?', score: '{score} stars', best: 'Best: {best}',
    },
    assets: {
      '01-idle': 'Idle', '02-perch': 'Perched', '03-look-around': 'Looking around', '04-drowsy': 'Drowsy',
      '05-sleep': 'Sleeping', '06-observe': 'Observing', '07-think': 'Thinking', '08-operate': 'Operating',
      '09-wait': 'Waiting', '10-success': 'Successful', '11-failure': 'Failed', '12-wave': 'Waving',
      '13-poked': 'Poked', '14-petted': 'Petted', '15-dragged': 'Picked up', '16-land': 'Landed',
      '17-move-left': 'Move left', '18-move-right': 'Move right', '19-peek-from-left': 'Peek from left',
      '20-peek-from-right': 'Peek from right', '21-gaming': 'Gaming', '22-hug-plush': 'Hugging spider plush',
      '23-upside-down': 'Upside down', '24-battle': 'Battle eyes',
      'fx-question': 'Question mark', 'fx-exclamation': 'Exclamation mark', 'fx-sweat': 'Sweat drop',
      'fx-anger': 'Angry', 'fx-heart': 'Hearts', 'fx-stars': 'Success stars', 'fx-sleep': 'Sleep symbols', 'fx-silk': 'Spider silk',
      'avatar-battle': 'Battle avatar', 'avatar-happy': 'Happy avatar', 'avatar-normal': 'Default avatar', 'icon-tray': 'Tray icon',
    },
  },
  zh: {
    lang: 'zh-CN', name: '卢登斯', console: 'Ludens 控制台',
    petLabel: '卢登斯：点击互动，拖动移动，右键设置和游戏',
    petTitle: '点击互动 · 拖动移动 · 右键游戏与设置',
    details: '详情', dismiss: '收起', dismissLabel: '收起这条日志',
    lines: ['我在。', '先观察，再行动。', '嗯？叫卢登斯。', '别戳了，在想了。', '这次有把握。大概。', '蛛腿也要休息。', '再试一次。', '一起看看？'],
    activity: {
      running: '运行中', error: '出错', complete: '完成', generating: '正在生成',
      content: '{title}内容，可滚动', arguments: '参数', result: '结果',
      aiControl: 'AI 已接管', manualControl: '已交还控制权',
      waiting: '已连接，等待 AI 接管', returned: '本轮已结束，控制权已交还',
    },
    menu: {
      open: '打开 Ludens 控制台', quit: '退出卢登斯', play: '玩一会儿 · 接星星',
      poses: '姿态', automatic: '自动（随活动与闲置切换）', effects: '特效', none: '无',
      hide: '隐藏桌宠', show: '显示桌宠', size: '大小', small: '小', medium: '中', large: '大',
      categories: { '日常': '日常', '工作': '工作', '互动': '互动', '方向': '方向', '特色': '特色', '特效': '特效' },
    },
    game: {
      label: '接星星', target: '接住星星', goal: '20 秒内接到 10 颗星星',
      win: '星星捕手！', lose: '就差一点，再玩一次？', score: '{score} 颗星星', best: '最佳：{best}',
    },
    assets: {
      '01-idle': '默认站立', '02-perch': '蛛肢托坐', '03-look-around': '四处张望', '04-drowsy': '犯困',
      '05-sleep': '睡觉', '06-observe': '观察', '07-think': '思考', '08-operate': '操作',
      '09-wait': '等待', '10-success': '成功得意', '11-failure': '失败吃瘪', '12-wave': '招手',
      '13-poked': '被戳惊讶', '14-petted': '被摸头开心', '15-dragged': '被拎起', '16-land': '落地蹲坐',
      '17-move-left': '向左移动', '18-move-right': '向右移动', '19-peek-from-left': '从左侧探头',
      '20-peek-from-right': '从右侧探头', '21-gaming': '打游戏', '22-hug-plush': '抱蜘蛛玩偶',
      '23-upside-down': '倒挂', '24-battle': '复眼开启',
      'fx-question': '问号', 'fx-exclamation': '感叹号', 'fx-sweat': '汗滴',
      'fx-anger': '生气', 'fx-heart': '爱心', 'fx-stars': '成功星星', 'fx-sleep': '睡眠符号', 'fx-silk': '蛛丝',
      'avatar-battle': '战斗头像', 'avatar-happy': '开心头像', 'avatar-normal': '普通头像', 'icon-tray': '托盘图标',
    },
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = companionI18n;
