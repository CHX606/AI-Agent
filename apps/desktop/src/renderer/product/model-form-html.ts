export const modelFormHtml = `<div class="model-field"><label for="model-base-url">接口地址</label>
          <input id="model-base-url" name="baseUrl" type="url" required spellcheck="false" placeholder="https://api.example.com/v1">
          <p>填写模型服务提供的 API 地址，而不是聊天网页地址。</p></div>
        <div class="model-field"><label for="model-name">模型名称</label>
          <input id="model-name" name="model" required spellcheck="false" placeholder="填写服务商提供的模型名称"></div>
        <div class="model-field"><label for="model-aux">辅助模型（可选）</label>
          <input id="model-aux" name="auxModel" spellcheck="false" maxlength="200" placeholder="留空则全部使用上面的模型">
          <p>同一接口地址下更便宜的模型，用于只读调查、历史摘要、经验提炼和提交信息；主任务和独立验收仍用主模型。</p></div>
        <div class="model-field"><label for="model-list">可切换的模型（可选）</label>
          <textarea id="model-list" name="models" rows="3" spellcheck="false" placeholder="每行一个，例如&#10;gpt-5.5&#10;gpt-5.5-mini"></textarea>
          <div class="model-list-actions"><button type="button" class="button-secondary" data-fetch-models>从服务获取</button>
            <span>在输入框右下角切换模型和思考程度；主模型始终可选。</span></div>
          <div class="model-fetch-result" hidden></div></div>
        <div class="model-field"><label for="model-api">接口类型</label>
          <select id="model-api" name="api">
            <option value="responses">Responses API（OpenAI 官方等）</option>
            <option value="chat_completions">Chat Completions（多数兼容服务、本地模型）</option>
          </select>
          <p>不确定时点“测试连接”，会自动检测并选中能用的那一种。</p></div>
        <div class="model-field"><label for="model-api-key">API Key <span class="model-key-state"></span></label>
          <input id="model-api-key" name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="留空保留现有密钥">
          <p>密钥由 Windows 加密保存，不会回传到这个页面。</p></div>
        <div class="model-field"><label for="model-input-price">价格（可选）</label>
          <div class="model-price-row">
            <input id="model-input-price" name="inputPrice" type="number" min="0" step="any" inputmode="decimal" placeholder="输入" aria-label="每百万输入 tokens 价格">
            <input id="model-output-price" name="outputPrice" type="number" min="0" step="any" inputmode="decimal" placeholder="输出" aria-label="每百万输出 tokens 价格">
            <select name="currency" aria-label="货币"><option value="¥">¥</option><option value="$">$</option></select>
          </div>
          <p>每百万 tokens 的价格，只用来在任务详情里估算费用；留空则只显示 tokens 数。</p></div>
        <div class="model-test-result" role="status" hidden></div>
        <div class="model-settings-footer"><span>保存不会发起模型请求，可以先测试连接。</span>
          <button type="button" class="button-secondary" data-test>测试连接</button>
          <button type="button" class="button-secondary" data-close>取消</button>
          <button type="submit" class="button-primary">保存设置</button></div>`;
