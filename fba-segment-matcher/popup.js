/**
 * FBA分段匹配工具 - Popup
 * 弹窗界面逻辑：读取配置、输入参数、匹配分段
 */
;(function () {
  'use strict'

  // ==================== 常量 ====================

  const CM_TO_IN = 1 / 2.54
  const KG_TO_LB = 2.20462262185
  const STORAGE_KEY = 'fba_segment_config'

  // ==================== DOM 引用 ====================

  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => document.querySelectorAll(sel)

  const btnReadConfig = $('#btnReadConfig')
  const btnMatch = $('#btnMatch')
  const configStatus = $('#configStatus')
  const pageHint = $('#pageHint')
  const readResult = $('#readResult')
  const convertInfo = $('#convertInfo')
  const resultSection = $('#resultSection')
  const resultContent = $('#resultContent')
  const inputLength = $('#inputLength')
  const inputWidth = $('#inputWidth')
  const inputHeight = $('#inputHeight')
  const inputWeight = $('#inputWeight')

  // ==================== 状态 ====================

  let configData = null // { dimWeightDivisor, sizeSegments, weightSegmentLookup, ... }

  // ==================== HTML 转义辅助 ====================

  function escHtml(text) {
    if (!text) return ''
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function escAttr(text) {
    if (!text) return ''
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  // ==================== 初始化 ====================

  async function init() {
    // 从 storage 恢复配置
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    if (stored[STORAGE_KEY]) {
      configData = stored[STORAGE_KEY]
      setConfigStatus('loaded', `已加载配置 (${configData.sizeSegments?.length || 0} 个尺寸分段, 重泡比=${configData.dimWeightDivisor})`)
    }

    // 检测当前活动页签
    detectCurrentPage()
  }

  /** 检测当前活动页签是否为 PMS */
  async function detectCurrentPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.url) {
        const url = new URL(tab.url)
        pageHint.textContent = `当前: ${url.hostname}`
      }
    } catch (e) {
      // 忽略
    }
  }

  // ==================== 配置读取 ====================

  btnReadConfig.addEventListener('click', async () => {
    btnReadConfig.disabled = true
    btnReadConfig.textContent = '⏳ 正在读取配置...'
    readResult.classList.remove('show')

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) {
        showReadResult('error', '❌ 无法获取当前页签')
        return
      }

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'readFbaConfig' })

      if (!response || !response.success) {
        showReadResult('error', `❌ 读取失败: ${response?.error || '未知错误'}`)
        setConfigStatus('error', '读取失败')
        return
      }

      const data = response.data
      configData = data

      // 持久化存储
      await chrome.storage.local.set({ [STORAGE_KEY]: data })

      const segCount = data.sizeSegments?.length || 0
      const divisor = data.dimWeightDivisor
      const weightSegCount = Object.values(data.weightSegmentLookup || {}).flat().length

      setConfigStatus('loaded', `已加载配置 (${segCount} 个尺寸分段, ${weightSegCount} 个重量分段)`)

      showReadResult(
        'success',
        `✅ 读取成功！<br>
         尺寸分段: <strong>${segCount}</strong> 条<br>
         重泡比: <strong>${divisor}</strong><br>
         重量分段: <strong>${weightSegCount}</strong> 条<br>
         读取时间: ${new Date(data.readAt).toLocaleString()}`
      )
    } catch (err) {
      showReadResult('error', `❌ 读取失败: ${err.message}<br><small>请确认当前页签是 PMS FBA参数配置页面</small>`)
      setConfigStatus('error', '读取失败')
    } finally {
      btnReadConfig.disabled = false
      btnReadConfig.textContent = '📥 读取当前页面配置'
    }
  })

  function showReadResult(type, html) {
    readResult.className = 'read-result show'
    readResult.innerHTML = `<div class="${type}">${html}</div>`
  }

  function setConfigStatus(status, text) {
    configStatus.className = `status-tag status-${status}`
    configStatus.textContent =
      status === 'empty' ? '未读取配置' : status === 'loaded' ? '✅ 已读取配置' : '⚠️ 读取失败'
  }

  // ==================== 参数输入实时转换预览 ====================

  const inputFields = [inputLength, inputWidth, inputHeight, inputWeight]
  inputFields.forEach((el) => {
    el.addEventListener('input', updateConvertPreview)
  })

  function updateConvertPreview() {
    const l = parseFloat(inputLength.value)
    const w = parseFloat(inputWidth.value)
    const h = parseFloat(inputHeight.value)
    const kg = parseFloat(inputWeight.value)

    if (!isNaN(l) && !isNaN(w) && !isNaN(h) && !isNaN(kg)) {
      const sorted = [l, w, h].sort((a, b) => b - a)
      const lIn = (sorted[0] * CM_TO_IN).toFixed(2)
      const wIn = (sorted[1] * CM_TO_IN).toFixed(2)
      const hIn = (sorted[2] * CM_TO_IN).toFixed(2)
      const lgIn = (sorted[0] * CM_TO_IN + 2 * (sorted[1] * CM_TO_IN + sorted[2] * CM_TO_IN)).toFixed(2)
      const lb = (kg * KG_TO_LB).toFixed(3)

      convertInfo.className = 'convert-info show'
      convertInfo.innerHTML = `
        英寸: 长=${lIn}" 宽=${wIn}" 高=${hIn}" | 长度+围长=${lgIn}" | 毛重=${lb} lb
      `
    } else {
      convertInfo.className = 'convert-info'
    }
  }

  // ==================== 匹配算法 ====================

  btnMatch.addEventListener('click', () => {
    if (!configData) {
      alert('请先在 PMS FBA参数配置页面读取配置！')
      return
    }

    const l = parseFloat(inputLength.value)
    const w = parseFloat(inputWidth.value)
    const h = parseFloat(inputHeight.value)
    const kg = parseFloat(inputWeight.value)

    // 校验输入
    const errors = []
    if (isNaN(l) || l <= 0) errors.push('长')
    if (isNaN(w) || w <= 0) errors.push('宽')
    if (isNaN(h) || h <= 0) errors.push('高')
    if (isNaN(kg) || kg <= 0) errors.push('毛重')
    if (errors.length) {
      alert(`请填写有效的: ${errors.join('、')}`)
      return
    }

    // 执行匹配
    const result = doMatch(l, w, h, kg)
    renderResult(result)
  })

  /**
   * 核心匹配算法
   * @param {number} lCm 长(cm)
   * @param {number} wCm 宽(cm)
   * @param {number} hCm 高(cm)
   * @param {number} kg 毛重(kg)
   */
  function doMatch(lCm, wCm, hCm, kg) {
    // 1. 排序: 最长边、次长边、最短边
    const sorted = [lCm, wCm, hCm].sort((a, b) => b - a)
    const lIn = sorted[0] * CM_TO_IN
    const wIn = sorted[1] * CM_TO_IN
    const hIn = sorted[2] * CM_TO_IN
    const lengthGirthIn = lIn + 2 * (wIn + hIn)
    const grossWeightLb = kg * KG_TO_LB

    const volumeCubicIn = lIn * wIn * hIn // 体积（立方英寸）
    const dimWeightDivisor = configData.dimWeightDivisor
    const dimWeightLb = volumeCubicIn / dimWeightDivisor  // 体积重量(lb)

    // 2. 按 sortOrder 排序
    const segments = [...configData.sizeSegments].sort(
      (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)
    )

    const diagnostics = []

    // 3. 遍历匹配
    for (const seg of segments) {
      // 确定发货重量（优先用后端返回的 weightValueTypeName，其次用字典值兜底）
      const shippingWeightLb = computeShippingWeight(seg, grossWeightLb, dimWeightLb)

      const weightStart = seg.weightStart // 大于该值，可为 null
      const weightEnd = seg.weightEnd     // 小于等于该值

      // ---- 逐项检查并记录诊断 ----
      const checks = []

      // 长度
      const lenOk = lIn <= seg.length
      checks.push({
        label: '长度',
        pass: lenOk,
        requirement: '≤' + seg.length + '"',
        actual: lIn.toFixed(2) + '"',
        fixHint: lenOk ? '' : ('需 ≤' + seg.length + '"（当前 ' + lIn.toFixed(2) + '" → 超出 ' + (lIn - seg.length).toFixed(2) + '"）')
      })

      // 宽度
      const widOk = wIn <= seg.width
      checks.push({
        label: '宽度',
        pass: widOk,
        requirement: '≤' + seg.width + '"',
        actual: wIn.toFixed(2) + '"',
        fixHint: widOk ? '' : ('需 ≤' + seg.width + '"（当前 ' + wIn.toFixed(2) + '" → 超出 ' + (wIn - seg.width).toFixed(2) + '"）')
      })

      // 高度
      const heiOk = hIn <= seg.height
      checks.push({
        label: '高度',
        pass: heiOk,
        requirement: '≤' + seg.height + '"',
        actual: hIn.toFixed(2) + '"',
        fixHint: heiOk ? '' : ('需 ≤' + seg.height + '"（当前 ' + hIn.toFixed(2) + '" → 超出 ' + (hIn - seg.height).toFixed(2) + '"）')
      })

      // 长度+围长
      const hasLg = seg.lengthGirth !== null && seg.lengthGirth !== undefined && seg.lengthGirth !== ''
      const lgOk = !hasLg || lengthGirthIn <= seg.lengthGirth
      checks.push({
        label: '长度+围长',
        pass: lgOk,
        requirement: hasLg ? ('≤' + seg.lengthGirth + '"') : '未配置（跳过）',
        actual: hasLg ? lengthGirthIn.toFixed(2) + '"' : '—',
        fixHint: lgOk ? '' : ('需 ≤' + seg.lengthGirth + '"（当前 ' + lengthGirthIn.toFixed(2) + '" → 超出 ' + (lengthGirthIn - seg.lengthGirth).toFixed(2) + '"）')
      })

      // 重量范围
      const wtOk = passWeightRange(shippingWeightLb, weightStart, weightEnd)
      let wtRequirement = ''
      if (weightStart != null && weightStart !== '') {
        wtRequirement += '(' + weightStart + ', '
      } else {
        wtRequirement += '(0, '
      }
      wtRequirement += (weightEnd != null && weightEnd !== '' ? weightEnd : '∞') + '] lb'
      let wtFixHint = ''
      if (!wtOk) {
        if (weightStart !== null && weightStart !== undefined && weightStart !== '' && shippingWeightLb <= weightStart) {
          wtFixHint = '需 >' + weightStart + ' lb（当前 ' + shippingWeightLb.toFixed(3) + ' lb → 还差 ' + (weightStart - shippingWeightLb + 0.001).toFixed(3) + ' lb）'
        } else if (weightEnd !== null && weightEnd !== undefined && weightEnd !== '' && shippingWeightLb > weightEnd) {
          wtFixHint = '需 ≤' + weightEnd + ' lb（当前 ' + shippingWeightLb.toFixed(3) + ' lb → 超出 ' + (shippingWeightLb - weightEnd).toFixed(3) + ' lb）'
        } else {
          wtFixHint = '重量不满足区间要求'
        }
      }
      checks.push({
        label: '发货重量',
        pass: wtOk,
        requirement: wtRequirement,
        actual: shippingWeightLb.toFixed(3) + ' lb（' + getWeightTypeName(seg) + '）',
        fixHint: wtFixHint
      })

      const allPass = checks.every(function (c) { return c.pass })
      diagnostics.push({
        segment: seg,
        shippingWeightLb: shippingWeightLb,
        weightTypeName: getWeightTypeName(seg),
        checks: checks,
        allPass: allPass
      })

      if (allPass) {
        // 全部通过 → 匹配成功！
        const weightSegments = configData.weightSegmentLookup[seg.id] || []
        const matchedWeightSeg = findWeightSegment(shippingWeightLb, weightSegments)

        return {
          matched: true,
          segment: seg,
          kg: kg,
          dimensions: { lCm: sorted[0], wCm: sorted[1], hCm: sorted[2], lIn: lIn, wIn: wIn, hIn: hIn },
          lengthGirthIn: lengthGirthIn,
          grossWeightLb: grossWeightLb,
          dimWeightLb: dimWeightLb,
          volumeCubicIn: volumeCubicIn,
          dimWeightDivisor: dimWeightDivisor,
          shippingWeightLb: shippingWeightLb,
          weightTypeName: getWeightTypeName(seg),
          matchedWeightSeg: matchedWeightSeg,
          allWeightSegs: weightSegments
        }
      }
    }

    // 未匹配 — 返回诊断信息
    return {
      matched: false,
      kg: kg,
      dimensions: { lCm: sorted[0], wCm: sorted[1], hCm: sorted[2], lIn: lIn, wIn: wIn, hIn: hIn },
      lengthGirthIn: lengthGirthIn,
      grossWeightLb: grossWeightLb,
      dimWeightLb: dimWeightLb,
      volumeCubicIn: volumeCubicIn,
      dimWeightDivisor: dimWeightDivisor,
      segments: segments,
      diagnostics: diagnostics
    }
  }

  /** 检查重量是否落在 (weightStart, weightEnd] 区间 */
  function passWeightRange(shippingWeightLb, weightStart, weightEnd) {
    // 起始值: 大于该值 (可为null，null代表无下限)
    if (weightStart !== null && weightStart !== undefined && weightStart !== '') {
      if (shippingWeightLb <= weightStart) return false
    }
    // 截止值: 小于等于该值
    if (weightEnd !== null && weightEnd !== undefined && weightEnd !== '') {
      if (shippingWeightLb > weightEnd) return false
    }
    return true
  }

  /**
   * 计算发货重量（根据该尺寸分段的「发货重量取值」规则）
   * 优先用后端返回的 weightValueTypeName，其次用 weightValueType 字典值兜底
   */
  function computeShippingWeight(seg, grossWeightLb, dimWeightLb) {
    const name = (seg.weightValueTypeName || '').toString()
    if (name.includes('商品重量') && !name.includes('体积')) {
      return grossWeightLb
    }
    if (name.includes('体积重量') && !name.includes('商品')) {
      return dimWeightLb
    }
    if (name.includes('发货重量')) {
      return Math.max(grossWeightLb, dimWeightLb)
    }
    // 兜底：字典值（1=商品重量, 2=体积重量, 3=发货重量）
    const wt = seg.weightValueType
    if (wt === 1) return grossWeightLb
    if (wt === 2) return dimWeightLb
    return Math.max(grossWeightLb, dimWeightLb)
  }

  /** 取「发货重量取值」的中文名称 */
  function getWeightTypeName(seg) {
    const name = (seg && seg.weightValueTypeName) || ''
    if (name) return name
    const wt = seg && seg.weightValueType
    if (wt === 1) return '商品重量'
    if (wt === 2) return '体积重量'
    if (wt === 3) return '发货重量'
    return `类型${wt ?? ''}`
  }

  /** 在重量分段列表中查找 (weightStart, weightEnd] */
  function findWeightSegment(shippingWeightLb, weightSegments) {
    for (const ws of weightSegments) {
      if (passWeightRange(shippingWeightLb, ws.weightStart, ws.weightEnd)) {
        return ws
      }
    }
    return null
  }

  function renderResult(result) {
    resultSection.style.display = 'block'

    if (!result.matched) {
      // 构建诊断表格
      let diagRows = ''
      if (result.diagnostics && result.diagnostics.length > 0) {
        diagRows = result.diagnostics.map(function (d) {
          const seg = d.segment
          const checkCells = d.checks.map(function (c) {
            if (c.pass) {
              return '<td class="diag-pass" title="' + escAttr(c.requirement) + ' — 通过">✓ ' + escHtml(c.actual) + '</td>'
            }
            return '<td class="diag-fail" title="' + escAttr(c.fixHint) + '">✗ ' + escHtml(c.actual) + '<br><span class="diag-req">要求 ' + escHtml(c.requirement) + '</span></td>'
          }).join('')

          // 修复建议行
          const fixLines = d.checks.filter(function (c) { return !c.pass && c.fixHint }).map(function (c) {
            return '<div class="diag-fix-item">🔧 <strong>' + escHtml(c.label) + '</strong>：' + escHtml(c.fixHint) + '</div>'
          }).join('')

          return '<tr>' +
            '<td class="diag-seg-name">' + escHtml(seg.sizeSegmentName || '分段#' + seg.sortOrder) +
            '<div class="diag-seg-meta">排序: ' + seg.sortOrder + ' | 重量取值: ' + escHtml(d.weightTypeName) + '</div>' +
            (fixLines ? '<div class="diag-fix-block">' + fixLines + '</div>' : '') +
            '</td>' +
            checkCells +
            '</tr>'
        }).join('')
      }

      resultContent.innerHTML =
        '<div class="no-match">⚠️ 未找到匹配的尺寸分段</div>' +
        '<div class="result-detail">' +
        '<table>' +
        '<tr><th>输入 (cm)</th><td>' + result.dimensions.lCm.toFixed(2) + ' × ' + result.dimensions.wCm.toFixed(2) + ' × ' + result.dimensions.hCm.toFixed(2) + '</td></tr>' +
        '<tr><th>英寸</th><td>' + result.dimensions.lIn.toFixed(2) + '" × ' + result.dimensions.wIn.toFixed(2) + '" × ' + result.dimensions.hIn.toFixed(2) + '"</td></tr>' +
        '<tr><th>长度+围长</th><td>' + result.lengthGirthIn.toFixed(2) + '"</td></tr>' +
        '<tr><th>毛重</th><td>' + result.grossWeightLb.toFixed(3) + ' lb</td></tr>' +
        '<tr><th>体积重量</th><td>' + result.dimWeightLb.toFixed(3) + ' lb (重泡比=' + result.dimWeightDivisor + ')</td></tr>' +
        '</table>' +
        '</div>' +
        '<div class="diag-section">' +
        '<div class="diag-section-title">📋 逐分段诊断（共 ' + (result.diagnostics ? result.diagnostics.length : 0) + ' 个分段）</div>' +
        '<div class="diag-legend"><span class="diag-ok">✓ 通过</span><span class="diag-ng">✗ 不通过</span>（悬停查看详情）</div>' +
        '<div class="diag-table-wrap"><table class="diag-table"><thead><tr>' +
        '<th>分段名称</th><th>长度</th><th>宽度</th><th>高度</th><th>长度+围长</th><th>发货重量</th>' +
        '</tr></thead><tbody>' + diagRows + '</tbody></table></div>' +
        '</div>'
      return
    }

    const seg = result.segment
    const ws = result.matchedWeightSeg

    let weightSegHtml = ''
    if (ws) {
      weightSegHtml = `
        <div class="result-card">
          <div><span class="label">发货重量分段</span></div>
          <div style="margin-top:4px;">
            <span class="value-name">大于 ${ws.weightStart != null ? ws.weightStart : '0'} lb，≤ ${ws.weightEnd} lb</span>
          </div>
        </div>
      `
    } else if (result.allWeightSegs.length > 0) {
      weightSegHtml = `
        <div class="no-match">⚠️ 该尺寸分段下未找到匹配的重量分段（所有重量分段表见下方）</div>
        <div class="result-detail">
          <table>
            <tr><th>重量分段</th><th>区间</th></tr>
            ${result.allWeightSegs.map((w) => `<tr><td>—</td><td>大于 ${w.weightStart ?? '0'}，≤ ${w.weightEnd}</td></tr>`).join('')}
          </table>
        </div>
      `
    } else {
      weightSegHtml = `<div class="match-hint">该尺寸分段未配置重量分段</div>`
    }

    resultContent.innerHTML = `
      <!-- 匹配的尺寸分段 -->
      <div class="result-card">
        <div><span class="label">商品尺寸分段</span> <span class="value-name">${seg.sizeSegmentName}</span></div>
        <div style="margin-top:2px;font-size:11px;color:#666;">排序: ${seg.sortOrder} | 重量取值: ${getWeightTypeName(seg)}</div>
      </div>

      ${weightSegHtml}

      <!-- 计算明细 -->
      <div class="result-detail">
        <table>
          <tr><th>输入 (cm)</th><td>${result.dimensions.lCm.toFixed(2)} × ${result.dimensions.wCm.toFixed(2)} × ${result.dimensions.hCm.toFixed(2)}</td></tr>
          <tr><th>英寸 (in)</th><td>${result.dimensions.lIn.toFixed(2)}" × ${result.dimensions.wIn.toFixed(2)}" × ${result.dimensions.hIn.toFixed(2)}"</td></tr>
          <tr><th>长度+围长</th><td>${result.lengthGirthIn.toFixed(2)}" ${seg.lengthGirth != null ? `(阈值 ≤${seg.lengthGirth}")` : '(未配置)'}</td></tr>
          <tr><th>体积</th><td>${result.volumeCubicIn.toFixed(2)} cu in</td></tr>
          <tr><th>毛重 (商品重量)</th><td><span class="highlight-num">${result.grossWeightLb.toFixed(3)} lb</span> (${result.kg.toFixed(3)} kg)</td></tr>
          <tr><th>体积重量</th><td><span class="highlight-num">${result.dimWeightLb.toFixed(3)} lb</span> (÷${result.dimWeightDivisor})</td></tr>
          <tr><th>发货重量</th><td><span class="highlight-num">${result.shippingWeightLb.toFixed(3)} lb</span> (${result.weightTypeName})</td></tr>
          <tr><th>尺寸分段限制</th><td>L≤${seg.length}" W≤${seg.width}" H≤${seg.height}" | 重量(${seg.weightStart ?? '—'}, ${seg.weightEnd}] lb</td></tr>
        </table>
      </div>
    `
  }

  // ==================== 回车快捷匹配 ====================
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement?.tagName === 'INPUT') {
      btnMatch.click()
    }
  })

  // ==================== 启动 ====================
  init()
})()