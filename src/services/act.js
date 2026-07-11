const path = require('path');
const PDFDocument = require('pdfkit');

// Акт о выполненной перевозке (2026-07-10) — реальная бухгалтерская потребность в
// Казахстане: и грузовладельцу, и перевозчику часто нужен документ по сделке для
// собственной отчётности, а раньше Trassa вообще ничего такого не выдавала.
//
// ВАЖНО: стандартные 14 встроенных шрифтов PDF (Helvetica и т.п.) не поддерживают
// кириллицу — используют WinAnsi-кодировку. Поэтому шрифт Roboto (Apache 2.0,
// свободно распространяемый, поддерживает кириллицу) забандлен в assets/fonts/
// и встраивается в каждый документ явно через doc.font(path).
const FONT_REGULAR = path.join(__dirname, '..', '..', 'assets', 'fonts', 'Roboto-Regular.ttf');
const FONT_BOLD = path.join(__dirname, '..', '..', 'assets', 'fonts', 'Roboto-Bold.ttf');

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtMoney(n) {
  if (n === null || n === undefined) return 'по договорённости';
  return Number(n).toLocaleString('ru-RU') + ' ₸';
}

// Пишет PDF прямо в переданный writable stream (обычно res) — не буферизует в памяти,
// что важно, т.к. Railway-инстанс небольшой.
function streamDeliveryAct({ cargo, bid, shipper, carrier, deliveredAt }, outStream) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(outStream);

  doc.font(FONT_BOLD).fontSize(16).text('АКТ О ВЫПОЛНЕННОЙ ПЕРЕВОЗКЕ ГРУЗА', { align: 'center' });
  doc.moveDown(0.3);
  doc.font(FONT_REGULAR).fontSize(10).fillColor('#555').text('Сформировано автоматически на платформе Trassa (trassakz.com)', { align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(1);

  doc.font(FONT_REGULAR).fontSize(11);
  doc.text('№ ' + cargo.id.slice(0, 8).toUpperCase() + '   от ' + fmtDate(deliveredAt || cargo.created_at));
  doc.moveDown(1);

  doc.font(FONT_BOLD).fontSize(12).text('Маршрут и груз');
  doc.font(FONT_REGULAR).fontSize(11);
  doc.text('Откуда: ' + cargo.from_city);
  doc.text('Куда: ' + cargo.to_city);
  doc.text('Тип груза: ' + cargo.cargo_type);
  doc.text('Вес: ' + cargo.weight_tons + ' т' + (cargo.volume_m3 ? ' · Объём: ' + cargo.volume_m3 + ' м³' : ''));
  doc.text('Дата подачи заявки: ' + fmtDate(cargo.pickup_date));
  doc.text('Дата доставки: ' + fmtDate(deliveredAt));
  doc.text('Стоимость перевозки: ' + fmtMoney(cargo.price_on_request ? null : (bid ? bid.price : cargo.price)));
  doc.moveDown(1);

  doc.font(FONT_BOLD).fontSize(12).text('Грузовладелец (Заказчик)');
  doc.font(FONT_REGULAR).fontSize(11);
  doc.text('Наименование/ФИО: ' + (shipper.company_name || shipper.name));
  if (shipper.company_name) doc.text('Контактное лицо: ' + shipper.name);
  doc.text('Телефон: ' + (shipper.phone || shipper.email || '—'));
  if (shipper.bin_verified && shipper.bin) doc.text('БИН: ' + shipper.bin);
  doc.moveDown(1);

  doc.font(FONT_BOLD).fontSize(12).text('Перевозчик (Исполнитель)');
  doc.font(FONT_REGULAR).fontSize(11);
  doc.text('Наименование/ФИО: ' + (carrier.company_name || carrier.name));
  if (carrier.company_name) doc.text('Контактное лицо: ' + carrier.name);
  doc.text('Телефон: ' + (carrier.phone || carrier.email || '—'));
  if (carrier.bin_verified && carrier.bin) doc.text('БИН: ' + carrier.bin);
  if (bid && bid.truck_type) doc.text('Транспорт: ' + bid.truck_type + (carrier.truck_number ? ', гос.номер ' + carrier.truck_number : ''));
  doc.moveDown(2);

  doc.font(FONT_REGULAR).fontSize(10).fillColor('#555').text(
    'Настоящий акт подтверждает факт выполнения перевозки груза в соответствии с ' +
    'заявкой, размещённой на платформе Trassa, и не является первичным бухгалтерским ' +
    'документом установленного образца. Стороны вправе оформить дополнительные ' +
    'документы по требованиям своего учёта.',
    { align: 'justify' }
  );
  doc.fillColor('#000');
  doc.moveDown(3);

  const y = doc.y;
  doc.font(FONT_REGULAR).fontSize(11);
  doc.text('Грузовладелец: _______________________', 50, y);
  doc.text('Перевозчик: _______________________', 320, y);

  doc.end();
}

module.exports = { streamDeliveryAct };
