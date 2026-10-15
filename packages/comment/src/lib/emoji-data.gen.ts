/**
 * emoji-data.gen.ts — 由 scripts/build-emoji-packs.mjs 从 https://cdn.jsdelivr.net/npm/@waline/emojis@1.3.0 的官方清单生成，请勿手改。
 * 清单在构建期烘焙进包：运行期只按需向 CDN 要图片本身，不再请求 info.json。
 */

export const EMOJI_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@waline/emojis@1.3.0';

export interface EmojiImageSet {
  /** 正文 token 里的库名，如 [weibo:smile] 的 weibo */
  token: string;
  /** CDN 上的目录名（与 token 不同：bb 对应 bilibili） */
  dir: string;
  prefix: string;
  type: 'png' | 'gif';
  items: string[];
}

export const EMOJI_IMAGE_SETS: EmojiImageSet[] = [
  {
    token: 'weibo',
    dir: 'weibo',
    prefix: 'weibo_',
    type: 'png',
    items: [
      'smile', 'lovely', 'blush', 'grin', 'laugh', 'joy', 'angry', 'bye', 'hammer', 'kiss',
      'love', 'mask', 'money', 'quiet', 'rage', 'sad', 'shy', 'sick', 'slient', 'smirk',
      'slap', 'antic', 'desire', 'longing', 'no_idea', 'look_down', 'clap', 'yum', 'sleep', 'dizzy_face',
      'chuckle', 'disappointed', 'flushed', 'heart_eyes', 'no', 'shuai', 'suprised', 'think', 'vomit', 'scream',
      'sleepy', 'sob', 'sunglasses', 'greddy', 'pick_nose', 'annoyed', 'awkward', 'confused', 'grievance', 'poor',
      'wink', 'rolling_eyes', 'watermalon', 'annoyed_left', 'annoyed_right', 'yawn', 'hufen', 'doge', 'husky', 'dog_annoyed',
      'dog_bye', 'dog_consider', 'dog_cry', 'dog_joy', 'dog_laugh', 'dog_sweat', 'dog_think', 'dog_yum', 'cat', 'cat_annoyed',
      'cat_bye', 'cat_cry', 'cat_think', 'girl_annoyed', 'boy', 'girl', 'panda', 'pig', 'rabbit', 'ultraman',
      'wool_group', 'yan', 'xi', 'soap', 'meng', 'jiong', 'geili', 'shenma', 'alpaca',
    ],
  },
  {
    token: 'bb',
    dir: 'bilibili',
    prefix: 'bb_',
    type: 'png',
    items: [
      'doge', 'sob', 'heart_eyes', 'cry', 'sad', 'smirk', 'sweat', 'antic', 'miantian', 'spit_blodd',
      'tiaokan', 'zhoumei', 'bye', 'clap', 'confused', 'crazy', 'cute', 'money', 'rage', 'scared',
      'shy', 'think', 'vomit', 'sleepy', 'flushed', 'kiss', 'rolling_eyes', 'thumbsup', 'yum', 'yum1',
      'lovely', 'sunglasses', 'pick_nose', 'annoyed', 'awkward', 'grievance', 'no_mouth', 'slap', 'slient', 'sleep',
      'greddy', 'chuckle', 'nosebleed', 'not_care', 'trollface', 'face_cry', 'look_down', 'mask', 'dizzy_face', 'test',
      'question_mask',
    ],
  },
  {
    token: 'qq',
    dir: 'qq',
    prefix: 'qq_',
    type: 'gif',
    items: [
      'smile', 'mouth_squirm', 'heart_eyes', 'flushed', 'sunglasses', 'sob', 'shy', 'silent', 'sleep', 'cry',
      'awkward', 'rage', 'yum', 'grin', 'confounded', 'sad', 'cool', 'cold_sweat', 'crazy', 'vomit',
      'chuckle', 'lovely', 'rolling_eyes', 'arrogant', 'yummy', 'sleepy', 'scared', 'sweat', 'laugh', 'solder',
      'fighting', 'scold', 'shush', 'dizzy_face', 'mad', 'feeble', 'skull', 'knock', 'bye', 'pick_nose',
      'clap', 'embarassed', 'snigger', 'annoyed_left', 'annoyed_right', 'yawn', 'look_down', 'grievance', 'pensive', 'smirk',
      'kiss_right', 'kiss', 'fearful', 'poor', 'wink', 'joy', 'doge', 'cover_face_cry', 'whatever', 'lift_check',
      'cute', 'antic', 'vomit_blood', 'surprised', 'pock_face', 'tangled', 'pretty', 'mask_fighting', 'mask_hug', 'mask',
      'working', 'busy', 'headache', 'worry', 'cover_face', 'burning_eyes', 'wowyo', 'hair_loss', 'question_mask', 'peep',
      'emm', 'waterlemon_face', 'rolling_face', 'hug', 'doubt', 'sweat1', 'white-yum', 'white1', 'white2', 'white_kiss',
      'white_shit', 'white_slap', 'white_sunglasses', 'white_thumbsup', 'bear1', 'bear2', 'bear3', 'bear4', 'bear5', 'bird1',
      'bird2', 'bird3', 'bird4', 'heart', 'rose', 'rose_dead', 'ghost', 'anger', 'lip', 'broken_heart',
      'coffee', 'alpaca', 'hongbao', 'firecracker', 'lantern', 'xi', 'thumbsup', 'ok', 'hold_fist', 'hand_shake',
      'come', 'v', 'fist', 'diss', 'thumbsdown', 'metal', 'no', 'lemon_face', 'moon', 'sun',
      'pig', 'knife', 'hocho', 'gun', 'tea', 'shit', 'tada', 'candy', 'watermelon', 'rice',
      'feeding_bottle', 'beer', 'karaoke', 'cake', 'egg', 'bomb', 'dollar', 'light', 'gift', 'flower',
      'plane', 'candle', 'ladybug', 'pill', 'basketball', 'pingpong', 'soccer', 'panda', 'pinwheel', 'ramen',
      'umbrella', 'banana', 'toilet_paper', 'bag', 'fa', 'handsome', 'mail', 'balloon', 'board', 'bow',
      'boy1', 'boy2', 'bulb', 'car', 'clock', 'cloudy', 'crab', 'example', 'frog', 'rain',
      'ring', 'sofa', 'train_body', 'train_tail', 'tran_head', '1', '10', '11', '2', '3',
      '4', '5', '6', '7', '8', '9', 'surrender', 'taiji_boy', 'taiji_girl',
    ],
  },
  {
    token: 'tieba',
    dir: 'tieba',
    prefix: 'tieba_',
    type: 'png',
    items: [
      'laugh', 'joy', 'antic', 'vomit_water', 'sob', 'wink', 'cry', 'dizzy_face', 'heart_eyes', 'huge_sweat',
      'rage', 'satisfied', 'sleep', 'smirk', 'sunglasses', 'sweat', 'vomit', 'lovely', 'angry', 'annoyed',
      'awkward', 'cute', 'pick_nose', 'shy', 'yum', 'grievance', 'chuckle', 'crazy', 'hurt', 'look_down',
      'rolling_eyes', 'agree', 'sorry', 'surprised', 'wow', 'doubt', 'thumbsup', 'v', 'metal', 'ok',
      'heart', 'red_scarf', 'sofa', 'moon', 'pill', 'rainbow', 'rose', 'shit', 'banana', 'toilet_paper',
      'cake', 'gift', 'candle', 'coffee',
    ],
  },
];
