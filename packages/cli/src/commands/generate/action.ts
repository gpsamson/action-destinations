import { Command, flags } from '@oclif/command'
import chalk from 'chalk'
import fs from 'fs-extra'
import globby from 'globby'
import { camelCase } from 'lodash'
import toTitleCase from 'to-title-case'
import ora from 'ora'
import path from 'path'
import { autoPrompt } from 'src/lib/prompt'
import { renderTemplates } from 'src/lib/templates'
import { addKeyToDefaultExport } from 'src/lib/codemods'
import GenerateTypes from './types'

export default class GenerateAction extends Command {
  private spinner: ora.Ora = ora()

  static description = `Scaffolds a new integration action.`

  static examples = [
    `$ segment generate:action ACTION`,
    `$ segment generate:action postToChannel --directory ./destinations/slack`
  ]

  static flags = {
    help: flags.help({ char: 'h' }),
    force: flags.boolean({ char: 'f' }),
    title: flags.string({ char: 't', description: 'the display name of the action' }),
    directory: flags.string({ char: 'd', description: 'base directory to scaffold the action' })
  }

  static args = [{ name: 'name', description: 'the action name', required: true }]

  async run() {
    const { args, flags } = this.parse(GenerateAction)

    // TODO make this configurable
    const integrationsGlob = './packages/destination-actions/src/destinations/*'
    const integrationDirs = await globby(integrationsGlob, {
      expandDirectories: false,
      onlyDirectories: true,
      gitignore: true,
      ignore: ['node_modules']
    })

    const answers = await autoPrompt(flags, [
      {
        type: 'text',
        name: 'title',
        message: 'Action title:',
        initial: toTitleCase(args.name),
        format: (val) => toTitleCase(val)
      },
      {
        type: 'select',
        name: 'directory',
        message: 'Which integration (directory)?',
        choices: integrationDirs.map((integrationPath) => {
          const [name] = integrationPath.split(path.sep).reverse()
          return {
            title: name,
            value: integrationPath
          }
        })
      }
    ])

    const slug = camelCase(args.name)
    const directory = answers.directory || './'
    const relativePath = path.join(directory, slug)
    const targetDirectory = path.join(process.cwd(), relativePath)
    const templatePath = path.join(__dirname, '../../../templates/actions/empty-action')

    try {
      this.spinner.start(`Creating ${chalk.bold(args.name)}`)
      renderTemplates(
        templatePath,
        targetDirectory,
        {
          name: answers.title,
          description: '',
          slug
        },
        flags.force
      )
      this.spinner.succeed(`Scaffold action`)
    } catch (err) {
      this.spinner.fail(`Scaffold action: ${chalk.red(err.message)}`)
      this.exit()
    }

    // Update destination with action
    const entryFile = require.resolve(path.relative(__dirname, path.join(process.cwd(), directory)))
    try {
      this.spinner.start(chalk`Updating destination definition`)
      const destinationStr = fs.readFileSync(entryFile, 'utf8')
      const updatedCode = addKeyToDefaultExport(destinationStr, 'actions', slug)
      fs.writeFileSync(entryFile, updatedCode, 'utf8')
      this.spinner.succeed()
    } catch (err) {
      this.spinner.fail(chalk`Failed to update your destination imports: ${err.message}`)
      this.exit()
    }

    try {
      this.spinner.start(chalk`Generating types for {magenta ${slug}} action`)
      await GenerateTypes.run(['--path', entryFile])
      this.spinner.succeed()
    } catch (err) {
      this.spinner.fail(chalk`Generating types for {magenta ${slug}} action: ${err.message}`)
      this.exit()
    }

    this.log(chalk.green(`Done creating "${args.name}" 🎉`))
    this.log(chalk.green(`Start coding! cd ${targetDirectory}`))
  }

  async catch(error: unknown) {
    if (this.spinner?.isSpinning) {
      this.spinner.fail()
    }
    throw error
  }
}
