const nodemailer = require('nodemailer');

test('email helper uses the supported transport API and sends a real attachment without SMTP', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  let delivered;
  const createTransport = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({
    sendMail: async options => {
      delivered = await transport.sendMail(options);
      return { ...delivered, response: 'saved in memory' };
    }
  });
  const previous = process.env.EMAIL_USER;
  process.env.EMAIL_USER = 'sender@example.test';
  try {
    const { sendEmail } = require('../../src/utils/nodemailer');
    const response = await sendEmail({
      to: 'operator@example.test', subject: 'Production report',
      text: 'Sample production report',
      attachments: [{ filename: 'production.xlsx', content: Buffer.from('sample workbook bytes') }]
    });
    expect(response).toBe('saved in memory');
    expect(delivered.envelope).toEqual({ from: 'sender@example.test', to: ['operator@example.test'] });
    expect(delivered.message.toString()).toContain('filename=production.xlsx');
    expect(delivered.message.toString()).toContain(Buffer.from('sample workbook bytes').toString('base64'));
  } finally {
    createTransport.mockRestore();
    process.env.EMAIL_USER = previous;
  }
});
