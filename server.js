require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Настройка подключения
const pool = new Pool({
    // Если есть целая строка DATABASE_URL, используем её, иначе собираем из кусочков
    connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,

    // Проверяем на localhost безопасно
    ssl: (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')) || process.env.DB_HOST === 'localhost'
        ? false
        : { rejectUnauthorized: false }
});

// Проверка подключения
pool.query('SELECT NOW()', (err) => {
    if (err) console.error('❌ Ошибка базы:', err.message);
    else console.log('✅ База данных подключена успешно!');
});

app.use(express.static('public'));

/**
 * 1. Получение всех объектов для отображения на карте
 */
// 1. Получение объектов для КАРТЫ
app.get('/api/objects', async (req, res) => {
    try {
        const query = `
            SELECT
                o.object_id, o.lat, o.lng, o.n_levels,
                (SELECT AVG(il_value) FROM sensor_readings sr JOIN sensors s ON sr.sensor_id = s.sensor_id WHERE s.object_id = o.object_id) as avg_il,
                (SELECT AVG(w_percent) FROM sensor_readings sr JOIN sensors s ON sr.sensor_id = s.sensor_id WHERE s.object_id = o.object_id) as avg_w
            FROM objects o;
        `;
        const { rows } = await pool.query(query);
        console.log("ОТВЕТ ДЛЯ КАРТЫ:", rows); // Смотрите это в черном окне терминала!
        res.json(rows);
    } catch (err) {
        console.error("ОШИБКА КАРТЫ:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. Получение данных для ГРАФИКА
app.get('/api/object-details/:objectId', async (req, res) => {
    const { objectId } = req.params;
    const selectedDate = req.query.date;

    try {
        let query, values;

        if (selectedDate) {
            const targetDay = selectedDate.split(' ')[0];
            query = `
                SELECT SR.*, S.depth_m
                FROM sensors S
                JOIN sensor_readings SR ON S.sensor_id = SR.sensor_id
                WHERE S.object_id = $1 AND DATE(SR.timestamp) = $2
                ORDER BY S.depth_m ASC;
            `;
            values = [objectId, targetDay];
        } else {
            query = `
                SELECT SR.*, S.depth_m
                FROM sensors S
                JOIN sensor_readings SR ON S.sensor_id = SR.sensor_id
                WHERE S.object_id = $1
                ORDER BY S.depth_m ASC;
            `;
            values = [objectId];
        }

        const result = await pool.query(query, values);
        res.json(result.rows);

    } catch (err) {
        console.error('Ошибка при получении данных объекта:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// Обязательно убедитесь, что включен парсер JSON в начале server.js:
app.use(express.json({ limit: '5mb' }));

// Маршрут для обработки авторизации
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
        }

        const user = result.rows[0];

        // Проверка пароля (для user_guest поле password может быть NULL)
        if (user.password !== password && !(user.password === null && !password)) {
            return res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
        }

        res.json({
            success: true,
            role: user.role,
            username: user.username,
            message: 'Успешный вход'
        });

    } catch (err) {
        console.error('Ошибка при входе в базе данных:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});


app.post('/api/telemetry', async (req, res) => {
    const {
        sensor_id,
        object_id,
        depth_m,
        w_percent,
        wl_value,
        wp_value,
        il_value,
        timestamp
    } = req.body;

    // Проверяем обязательные поля
    if (!sensor_id || !object_id || depth_m === undefined) {
        return res.status(400).json({
            success: false,
            message: 'Отсутствуют обязательные параметры (sensor_id, object_id или depth_m)'
        });
    }

    try {
        // Шаг 1. Сначала убеждаемся, что датчик зарегистрирован в таблице sensors
        // (если его нет, база автоматически добавит его, чтобы не сработал Foreign Key)
        await pool.query(`
            INSERT INTO sensors (sensor_id, object_id, depth_m)
            VALUES ($1, $2, $3)
            ON CONFLICT (sensor_id) DO NOTHING;
        `, [sensor_id, object_id, depth_m]);

        // Шаг 2. Записываем само измерение в таблицу sensor_readings с переданным временем
        const readingQuery = `
            INSERT INTO sensor_readings (sensor_id, timestamp, w_percent, wl_value, wp_value, il_value)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `;

        // Если timestamp не передан извне, можно подставить текущее время (NOW())
        const eventTime = timestamp || new Date();

        const values = [
            sensor_id,
            eventTime,
            w_percent || null,
            wl_value || null,
            wp_value || null,
            il_value || null
        ];

        const result = await pool.query(readingQuery, values);

        res.json({
            success: true,
            message: 'Данные телеметрии успешно сохранены',
            reading: result.rows[0]
        });

    } catch (err) {
        console.error('Ошибка при сохранении телеметрии:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера при записи данных' });
    }
});

/**
 * Пакетная отправка телеметрии — приём большого пакета показаний ОДНИМ запросом,
 * вместо отдельного POST на каждое значение.
 *
 * Тело запроса — один из двух вариантов:
 *   [ {...}, {...}, ... ]                варианты полей как в /api/telemetry
 *   { "readings": [ {...}, {...} ] }
 *
 * Каждый элемент массива:
 *   { "sensor_id", "object_id", "depth_m", "w_percent", "wl_value", "wp_value", "il_value", "timestamp" }
 *   (timestamp необязателен — если не передан, подставляется текущее время)
 *
 * Одна повреждённая/неполная запись в пакете НЕ отменяет весь пакет —
 * она просто попадает в "errors", а остальные записи сохраняются.
 */
app.post('/api/telemetry/batch', async (req, res) => {
    const readings = Array.isArray(req.body) ? req.body : req.body?.readings;

    if (!Array.isArray(readings) || readings.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Ожидается массив показаний: [ {...}, {...} ] или { "readings": [ {...}, {...} ] }'
        });
    }

    // Разбираем и валидируем каждую запись отдельно, чтобы одна плохая запись
    // не роняла весь пакет
    const valid = [];
    const errors = [];

    readings.forEach((item, index) => {
        const { sensor_id, object_id, depth_m, w_percent, wl_value, wp_value, il_value, timestamp } = item || {};

        if (!sensor_id || !object_id || depth_m === undefined) {
            errors.push({
                index,
                sensor_id: sensor_id ?? null,
                message: 'Отсутствуют обязательные параметры (sensor_id, object_id или depth_m)'
            });
            return;
        }

        valid.push({
            sensor_id,
            object_id,
            depth_m,
            w_percent: w_percent ?? null,
            wl_value: wl_value ?? null,
            wp_value: wp_value ?? null,
            il_value: il_value ?? null,
            timestamp: timestamp || new Date().toISOString()
        });
    });

    if (valid.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Ни одна запись в пакете не прошла проверку',
            saved_count: 0,
            error_count: errors.length,
            errors
        });
    }

    try {
        // Шаг 1. Регистрируем все новые датчики одним запросом (уже существующие пропускаются)
        await pool.query(`
            INSERT INTO sensors (sensor_id, object_id, depth_m)
            SELECT * FROM UNNEST($1::text[], $2::text[], $3::numeric[])
            ON CONFLICT (sensor_id) DO NOTHING;
        `, [
            valid.map(v => v.sensor_id),
            valid.map(v => v.object_id),
            valid.map(v => v.depth_m)
        ]);

        // Шаг 2. Вставляем ВСЕ показания одним запросом (а не по одному)
        const result = await pool.query(`
            INSERT INTO sensor_readings (sensor_id, timestamp, w_percent, wl_value, wp_value, il_value)
            SELECT * FROM UNNEST($1::text[], $2::timestamptz[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[])
            RETURNING *;
        `, [
            valid.map(v => v.sensor_id),
            valid.map(v => v.timestamp),
            valid.map(v => v.w_percent),
            valid.map(v => v.wl_value),
            valid.map(v => v.wp_value),
            valid.map(v => v.il_value)
        ]);

        res.json({
            success: true,
            message: `Сохранено ${result.rows.length} из ${readings.length} показаний`,
            saved_count: result.rows.length,
            error_count: errors.length,
            readings: result.rows,
            errors
        });

    } catch (err) {
        console.error('Ошибка при пакетном сохранении телеметрии:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера при пакетной записи данных' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});