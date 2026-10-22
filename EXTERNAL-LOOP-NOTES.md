# dsh 澶栭儴寮曟搸鎻掍欢 鈥?寮€鍙戜氦鎺ョ瑪璁帮紙鏈彁浜わ紝浠呮湰鍦帮級

鐩爣锛欴SH 妗岄潰 UI 涓嶅彉锛宎gent loop 鎹㈡垚澶栭儴 CLI harness锛坈laude / pi / opencode锛夈€?璺嚎 A锛歩n-tree 鎻掍欢瀹炵幇 AgentFactory + base bundle 涓€琛?YAML 鎹㈣銆?
## 宸茬‘璁ょ殑鎺ョ紳锛堝叏閮ㄥ疄娴嬭鐮侊級

- 宸ュ巶鎺ュ彛 `AgentFactory`锛歚packages/core/agent/src/index.ts:171` 鈥?  `createAgent(ownerCtx, options): Promise<AgentHandle>` + `resume(ownerCtx, options)`
- 娉ㄥ唽锛歚ctx.agents.setFactory(this)`锛堝崟甯綅锛岄噸澶嶆敞鍐屾姏閿欙級鈥?index.ts:355
- Agent 琛ㄩ潰锛坄packages/core/agent/src/runtime-types.ts:163-243`锛夛細
  options/session/inbox/status/ctx + cancel(cause,opts)/whenIdle()/runMaintenance(fn)/
  send(msg,target,wakeup)/followup(msg)/steer(msg)/inject(msg)
- 榛樿瀹炵幇鍙傝€冿細`packages/core/agent-loop/src/index.ts:341` `class AgentLoop extends Service
  implements AgentFactory`锛宨nject = ['agents','sessions','llm','tools','systemPrompt',
  'sessionProjections']锛涙瀯閫犻噷 setFactory + 娉ㄥ唽 turnBoundary/inbox 涓や釜鎶曞奖锛?378-381锛?- UI 鍙悆浼氳瘽浜嬩欢鏃ュ織锛歶ser/message銆乤ssistant/message锛堝唴宓岀揣鍑戞祦锛夈€乼ool/call銆?  tool/result銆乼urn/start|end锛涙椿娴?`agent/assistant-stream`锛坰tart/chunk*/end锛?- 浼氳瘽浜嬩欢鍐欏叆锛歚Session.append()`锛坧ackages/core/session/src/types.ts:282 浜嬩欢琛紝:418 娉ㄦ槑鎻掍欢鍙啓锛?- 琛屾浛鎹㈡満鍒讹細`packages/bundle/base/cordis.patch.yml:511` `- id: agent-loop / name:
  '@deepseek-ai/dsh-agent-loop'` 鈫?in-tree 鐩存帴鏀硅繖涓€琛屾寚鍚戞柊鍖呭嵆鍙紙fork 鍐咃級
- 瀹樻柟鍙傝€冿細`packages/acp/acp`锛堝閮ㄥ崗璁啍ctx.agents 鐨勬牱鏉匡級銆?  `packages/subagent/subagent-claude-code`锛坈laude agent-sdk 瀛愯繘绋嬬鐞嗗彲鎼級銆?  `packages/subagent/subagent-acp`锛坥pencode 璧?ACP 鐨勬満鍒讹級

## 寰呰锛堜笅娆′粠杩欓噷缁х画锛?
1. CreateAgentOptions / ResumeAgentOptions / AgentOptions / AgentHandle 鐨勭‘鍒囧舰鐘?   锛堜笉鍦?runtime-types.ts锛屽幓 packages/core/agent/src/types.ts 鎵撅級
2. Session.append 鐨勪簨浠?payload 褰㈢姸锛坅ssistant/message v2 鍐呭祵娴佹牸寮忕殑鏈€灏忓悎娉曟牱渚?鈥?   鍙粠 agent-loop 婧愮爜鎴?session 鍖呮祴璇曢噷鎶勶級
3. agent-loop 鐨?turnBoundary/inbox 鎶曞奖娉ㄥ唽浠ｇ爜锛堢収鎶勫埌鎴戜滑鎻掍欢锛?4. 浼氳瘽鏍囬鐢熸垚绛夋潅椤规槸鍚︿緷璧?ctx.llm锛堟爣棰樺彲鑷繁 append session 浜嬩欢锛?
## 闃舵鈶犻鏋讹紙涓嬩竴姝ユ墽琛岋級

1. 寤哄寘 `packages/core/agent-loop-external/`锛坧ackage.json: @deepseek-ai/dsh-agent-loop-external,
   main 鎸?src/index.ts 鎴栧厛 tsc锛泈orkspace 閲屽姞 pnpm-workspace 宸茶鐩?packages/*锛?2. `ExternalAgentLoop extends Service implements AgentFactory`锛?   - createAgent/resume 鈫?寤?ExternalAgent锛坕mplements Agent锛?   - ExternalAgent.followup(msg)锛歛ppend user/message 鈫?spawn 澶栭儴 CLI锛堝厛鐢?claude
     stream-json锛岄€昏緫浠?ZCode 椤圭洰 apps/engine-shim/src/claude.ts 鎼級鈫?娴佸紡 append
     assistant/message锛堥樁娈碘憼鍙厛涓€娆℃€?canned 鏂囨湰楠岃瘉鎺ョ紳锛夆啋 turn 浜嬩欢
   - cancel 鏉€瀛愯繘绋嬶紱whenIdle 绌?promise锛泂tatus 鐘舵€佹満鏈€灏忓寲
3. base bundle 琛屾浛鎹細cordis.patch.yml agent-loop 琛?name 鏀规柊鍖咃紙fork 鍐咃級
4. 楠岃瘉锛歝d D:\deepseek-harness && set ELECTRON_MIRROR=... && npx pnpm@11.28.5 run dev:desktop
   锛坉ev 鏁版嵁闅旂鍦?apps/desktop/.desktop-build/development/锛屼笉纰扮湡瀹?~/.dsh锛?   妗岄潰鍙戞秷鎭?鈫?鑻ュ洖鐨勬槸鎻掍欢鐨?canned 鏂囨湰 = 鎺ョ紳鎵撻€?5. 闃舵鈶★細claude 鐪熸ˉ锛堟祦寮忔槧灏勶級锛涢樁娈碘憿锛歰pencode(ACP)/pi锛涢樁娈碘懀锛氬鎵规槧灏?resume/steer

## 鐜澶囧繕

- dev 鍚姩蹇呴』甯?ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/锛堣８杩炲繀鍗★級
- pnpm 鐢?npx pnpm@11.28.5锛堝叏灞€ 10 涓?lockfile 涓嶅尮閰嶏級
- 鍏ㄩ噺鏋勫缓宸查€氳繃锛沝ev:desktop 澧為噺寰堝揩
- ZCode 鐗堝悓绫诲疄鐜帮紙浜嬩欢鏄犲皠鍙傝€冿級锛欳:\Users\15234\.zcode\workspace\1792602180782-.../ZCode/apps/engine-shim/

## 闃舵鈶¤俯鍧戣褰曪紙鎸夊彂鐜伴『搴忥級

1. **鍥炲瀹屾垚鍚庢秷澶?*锛坉4e45f940c 淇锛夛細assistant/message 蹇呴』鍖呭湪
   step/start..step/end 閲岋紝涓斿鎴风 ClientAssistantStream 浼氬湪"杩熷埌鐨?start
   甯?涓婃暣娴侀噸寤猴紙rebaseline锛夆€斺€旀渶鍚庝竴杞?tool-less 鍥炲悎鐨勬彁浜ゅ繀椤绘帹杩熷埌
   result 浜嬩欢锛屽苟鍦ㄤ笅涓€杞 delta 涔嬪墠鍏堟彁浜?鏀舵鍐嶅紑鏂版銆?2. **鎹熷潖浼氳瘽鏃犳硶鍔犺浇**锛氫慨澶嶁憼涔嬪墠鐨勬棫鏋勫缓鍐欑殑鏃ュ織缂?turn/step 鍧愭爣锛岃
   v3鈫抳4 涓ユ牸鏍￠獙鍣ㄥ垽 corrupt锛?assistant/message does not match an open turn
   and step"锛夈€傚鐞?鐩存帴鍒犳崯鍧忎細璇濓紙dev 娌欑鏁版嵁锛夈€傛牎楠岃鍒欓暅鍍忓湪
   鏍圭洰褰?scan-sessions.mjs锛坣ode scan-sessions.mjs <sessions鐩綍> [--delete]锛?   閫愭潯瑙?zstd 甯?閲嶆斁鎷彿鐘舵€佹満锛夛紱dump-session.mjs 鍙叏鏂?dump 鍗曚釜浼氳瘽銆?3. **鍥炲鏁翠綋涓虹┖銆乼urn 鍗?宸插畬鎴?**锛氫袱涓彔鍔犲師鍥犫€斺€?   a. 妯″瀷閾炬妸 dsh AgentOptions.model锛坉eepseek-flash锛宒sh 鐩綍鍛藉悕绌洪棿锛夊綋
      --model 浼犵粰 claude锛孊igModel 400銆屾ā鍨嬩笉瀛樺湪銆嶏紱claude 鎶?API 閿欒鍖呮垚
      鍚堟垚 assistant 娑堟伅锛堟棤浠讳綍 stream delta锛変笖 result 浠嶆槸 subtype=success銆?   b. commitRound 鐨?鏁存秷鎭悎鎴?鍒嗘敮琚畧鍦?round!==undefined 涓嬶紝鑰?round 鍙?      鍦ㄩ鏉?delta 鏃舵墠鍒涘缓鈥斺€旈浂 delta 鐨勬暣鏉℃秷鎭闈欓粯涓㈠純銆?   淇锛氬悎鎴愬垎鏀敼涓?round 瀛樺湪涓斿凡娴?delta 鏃跺彧琛?tool-use 鍧楋紝鍚﹀垯鏁存秷鎭?   鍚堟垚锛?-model 閾炬敼涓?鐜鍙橀噺 pin > 鐢ㄦ埛鏄惧紡閫夋嫨锛坧ending锛岃蹇嗗湪
   engineModelFlag 璺ㄨ疆淇濇寔锛? 涓嶄紶锛坈laude 鐢ㄨ嚜宸遍厤缃殑榛樿妯″瀷锛夈€?   AgentOptions.model 姘镐笉閫忎紶缁欏紩鎿庛€?4. **E2E 楠岃瘉鏂瑰紡**锛堜笉纰?UI锛夛細DSH_HOME=<dev home> && npx pnpm@11.28.5
   --filter @deepseek-ai/dsh exec node lib/bin.js --profile headless "浠诲姟鏂囨湰"
   鈥斺€攈eadless bundle 鐩存帴鍙犲湪 dsh-base 涓婏紝缁ф壙 agent-loop鈫抏xternal 鎹㈣锛?   璺戝畬鎵撳嵃鎸佷箙鍖栫粨鏋滃苟钀戒竴浠藉彲鏍￠獙鐨勪細璇濇棩蹇椼€?
