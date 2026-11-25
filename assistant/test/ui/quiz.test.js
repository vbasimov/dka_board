import test from 'node:test'
import assert from 'node:assert/strict'
import { renderQuiz } from '../../ui/quiz.js'

const fact = { id: 'f1', claim: 'Платежи передают события в Kafka', sourceType: 'кэш КАФО', sourceRef: 'page_id=123; version=14' }

test('карточка показывает источник и три действия с подсказками клавиш 1/2/3', () => {
  const html = renderQuiz([fact], 1)
  assert.match(html, /Платежи передают события в Kafka/)
  assert.match(html, /page_id=123; version=14/)
  assert.match(html, /data-verdict="confirm"/)
  assert.match(html, /data-verdict="unreliable"/)
  assert.match(html, /data-verdict="skip"/)
  assert.match(html, /<span class="kbd">1<\/span>Подтвердить/)
  assert.match(html, /<span class="kbd">2<\/span>Недостоверно/)
  assert.match(html, /<span class="kbd">3<\/span>Пропустить/)
})

test('показывается ровно одна карточка за раз, даже если фактов несколько', () => {
  const html = renderQuiz([fact, { ...fact, id: 'f2' }, { ...fact, id: 'f3' }], 3)
  assert.equal((html.match(/data-verdict="confirm"/g) || []).length, 1)
  assert.match(html, /quiz-card" data-id="f1"/)
})

test('строка прогресса показывает остаток из общего числа', () => {
  const html = renderQuiz([fact, { ...fact, id: 'f2' }], 5)
  assert.match(html, /Осталось проверить: 2 из 5/)
})

test('все проверено сегодня — хорошая новость с действием вернуться в сводку', () => {
  const html = renderQuiz([], 3)
  assert.match(html, /Все факты на сегодня проверены/)
  assert.match(html, /data-goto="summary"/)
})

test('изначально проверять нечего — без действия, это не ошибка', () => {
  const html = renderQuiz([], 0)
  assert.match(html, /На сегодня проверять нечего/)
  assert.doesNotMatch(html, /<button/)
})

test('содержимое карточки экранируется', () => {
  const html = renderQuiz([{ ...fact, claim: '<img src=x onerror=1>' }], 1)
  assert.doesNotMatch(html, /<img/)
})
