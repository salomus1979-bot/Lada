'use strict';

/**
 * Страница «Этот раздел только для администраторов».
 *
 * Показывает, под каким аккаунтом человек вошёл и какие у него роли. Это не
 * украшение: без этой строки «меня не пустило в /admin» и «меня не
 * перенаправило в /admin после входа» выглядят одинаково, а причина у них
 * одна и та же — ролей администратора у аккаунта нет. Ответ на вопрос «почему»
 * должен быть на экране, а не в базе.
 *
 * Запросов здесь нет — только вызов функции из api.js (правило 3). Запрос
 * один, и он про самого человека: `GET /auth/me`.
 */

import { getMe } from './api.js';
import { $ } from './ui.js';

/** Человеческие названия ролей: в ответе они машинные. */
const ROLE_TITLES = {
  client: 'клиент',
  master: 'мастер',
  admin: 'администратор',
  owner: 'владелец',
};

async function showAccount() {
  const box = $('[data-who]');
  try {
    const user = await getMe();
    const roles = (user.roles || []).map((role) => ROLE_TITLES[role] || role);
    box.textContent = roles.length > 0
      ? `Вы вошли как ${user.name} (${user.email}), роли аккаунта: ${roles.join(', ')}.`
      : `Вы вошли как ${user.name} (${user.email}), ролей у аккаунта нет.`;
    box.hidden = false;
  } catch (err) {
    // 401 — сессии нет вовсе: в раздел ведёт вход, а не роль.
    if (err.status !== 401) return;
    box.replaceChildren(document.createTextNode('Похоже, вы не вошли. '));
    const link = document.createElement('a');
    link.href = '/login.html';
    link.textContent = 'Войти';
    box.append(link);
    box.hidden = false;
    // Любая другая ошибка строки не рисует: основной текст страницы и без
    // неё объясняет, что произошло.
  }
}

showAccount();
