import sys, os, shutil, logging, tarfile, tempfile, urllib
from galaxy.web.base.controller import BaseUIController
from galaxy import web, util
from galaxy.datatypes import checkers
import galaxy.util.shed_util_common as suc

from galaxy import eggs
eggs.require('mercurial')
from mercurial import hg, ui, commands

log = logging.getLogger( __name__ )

undesirable_dirs = [ '.hg', '.svn', '.git', '.cvs' ]
undesirable_files = [ '.hg_archival.txt', 'hgrc', '.DS_Store' ]
CHUNK_SIZE = 2**20 # 1Mb

class UploadController( BaseUIController ):
    @web.expose
    @web.require_login( 'upload', use_panels=True )
    def upload( self, trans, **kwd ):
        params = util.Params( kwd )
        message = util.restore_text( params.get( 'message', ''  ) )
        status = params.get( 'status', 'done' )
        commit_message = util.restore_text( params.get( 'commit_message', 'Uploaded'  ) )
        category_ids = util.listify( params.get( 'category_id', '' ) )
        categories = suc.get_categories( trans )
        repository_id = params.get( 'repository_id', '' )
        repository = suc.get_repository_in_tool_shed( trans, repository_id )
        repo_dir = repository.repo_path( trans.app )
        repo = hg.repository( suc.get_configured_ui(), repo_dir )
        uncompress_file = util.string_as_bool( params.get( 'uncompress_file', 'true' ) )
        remove_repo_files_not_in_tar = util.string_as_bool( params.get( 'remove_repo_files_not_in_tar', 'true' ) )
        uploaded_file = None
        upload_point = self.__get_upload_point( repository, **kwd )
        tip = repository.tip( trans.app )
        file_data = params.get( 'file_data', '' )
        url = params.get( 'url', '' )
        # Part of the upload process is sending email notification to those that have registered to
        # receive them.  One scenario occurs when the first change set is produced for the repository.
        # See the suc.handle_email_alerts() method for the definition of the scenarios.
        new_repo_alert = repository.is_new( trans.app )
        uploaded_directory = None
        if params.get( 'upload_button', False ):
            if file_data == '' and url == '':
                message = 'No files were entered on the upload form.'
                status = 'error'
                uploaded_file = None
            elif url and url.startswith( 'hg' ):
                # Use mercurial clone to fetch repository, contents will then be copied over.
                uploaded_directory = tempfile.mkdtemp()
                repo_url = 'http%s' % url[ len( 'hg' ): ]
                repo_url = repo_url.encode( 'ascii', 'replace' )
                commands.clone( suc.get_configured_ui(), repo_url, uploaded_directory )
            elif url:
                valid_url = True
                try:
                    stream = urllib.urlopen( url )
                except Exception, e:
                    valid_url = False
                    message = 'Error uploading file via http: %s' % str( e )
                    status = 'error'
                    uploaded_file = None
                if valid_url:
                    fd, uploaded_file_name = tempfile.mkstemp()
                    uploaded_file = open( uploaded_file_name, 'wb' )
                    while 1:
                        chunk = stream.read( CHUNK_SIZE )
                        if not chunk:
                            break
                        uploaded_file.write( chunk )
                    uploaded_file.flush()
                    uploaded_file_filename = url.split( '/' )[ -1 ]
                    isempty = os.path.getsize( os.path.abspath( uploaded_file_name ) ) == 0
            elif file_data not in ( '', None ):
                uploaded_file = file_data.file
                uploaded_file_name = uploaded_file.name
                uploaded_file_filename = os.path.split( file_data.filename )[ -1 ]
                isempty = os.path.getsize( os.path.abspath( uploaded_file_name ) ) == 0
            if uploaded_file or uploaded_directory:
                ok = True
                isgzip = False
                isbz2 = False
                if uploaded_file:
                    if uncompress_file:
                        isgzip = checkers.is_gzip( uploaded_file_name )
                        if not isgzip:
                            isbz2 = checkers.is_bz2( uploaded_file_name )
                    if isempty:
                        tar = None
                        istar = False
                    else:                
                        # Determine what we have - a single file or an archive
                        try:
                            if ( isgzip or isbz2 ) and uncompress_file:
                                # Open for reading with transparent compression.
                                tar = tarfile.open( uploaded_file_name, 'r:*' )
                            else:
                                tar = tarfile.open( uploaded_file_name )
                            istar = True
                        except tarfile.ReadError, e:
                            tar = None
                            istar = False
                else:
                    # Uploaded directory
                    istar = False
                if istar:
                    ok, message, files_to_remove, content_alert_str, undesirable_dirs_removed, undesirable_files_removed = \
                        self.upload_tar( trans, repository, tar, uploaded_file, upload_point, remove_repo_files_not_in_tar, commit_message, new_repo_alert )
                elif uploaded_directory:
                    ok,message, files_to_remove, content_alert_str, undesirable_dirs_removed, undesirable_files_removed = \
                        self.upload_directory( trans, repository, uploaded_directory, upload_point, remove_repo_files_not_in_tar, commit_message, new_repo_alert )
                else:
                    if ( isgzip or isbz2 ) and uncompress_file:
                        uploaded_file_filename = self.uncompress( repository, uploaded_file_name, uploaded_file_filename, isgzip, isbz2 )
                    if upload_point is not None:
                        full_path = os.path.abspath( os.path.join( repo_dir, upload_point, uploaded_file_filename ) )
                    else:
                        full_path = os.path.abspath( os.path.join( repo_dir, uploaded_file_filename ) )
                    # Move the uploaded file to the load_point within the repository hierarchy.
                    shutil.move( uploaded_file_name, full_path )
                    # See if any admin users have chosen to receive email alerts when a repository is
                    # updated.  If so, check every uploaded file to ensure content is appropriate.
                    check_contents = suc.check_file_contents( trans )
                    if check_contents and os.path.isfile( full_path ):
                        content_alert_str = self.__check_file_content( full_path )
                    else:
                        content_alert_str = ''
                    commands.add( repo.ui, repo, full_path )
                    # Convert from unicode to prevent "TypeError: array item must be char"
                    full_path = full_path.encode( 'ascii', 'replace' )
                    commands.commit( repo.ui, repo, full_path, user=trans.user.username, message=commit_message )
                    if full_path.endswith( 'tool_data_table_conf.xml.sample' ):
                        # Handle the special case where a tool_data_table_conf.xml.sample file is being uploaded by parsing the file and adding new entries
                        # to the in-memory trans.app.tool_data_tables dictionary.
                        error, error_message = suc.handle_sample_tool_data_table_conf_file( trans.app, full_path )
                        if error:
                            message = '%s<br/>%s' % ( message, error_message )
                    # See if the content of the change set was valid.
                    admin_only = len( repository.downloadable_revisions ) != 1
                    suc.handle_email_alerts( trans, repository, content_alert_str=content_alert_str, new_repo_alert=new_repo_alert, admin_only=admin_only )
                if ok:
                    # Update the repository files for browsing.
                    suc.update_repository( repo )
                    # Get the new repository tip.
                    if tip == repository.tip( trans.app ):
                        message = 'No changes to repository.  '
                        status = 'warning'
                    else:
                        if ( isgzip or isbz2 ) and uncompress_file:
                            uncompress_str = ' uncompressed and '
                        else:
                            uncompress_str = ' '
                        if uploaded_directory:
                            source_type = "repository"
                            source = url
                        else:
                            source_type = "file"
                            source = uploaded_file_filename
                        message = "The %s '%s' has been successfully%suploaded to the repository.  " % ( source_type, source, uncompress_str )
                        if istar and ( undesirable_dirs_removed or undesirable_files_removed ):
                            items_removed = undesirable_dirs_removed + undesirable_files_removed
                            message += "  %d undesirable items (.hg .svn .git directories, .DS_Store, hgrc files, etc) were removed from the archive.  " % items_removed
                        if istar and remove_repo_files_not_in_tar and files_to_remove:
                            if upload_point is not None:
                                message += "  %d files were removed from the repository relative to the selected upload point '%s'.  " % ( len( files_to_remove ), upload_point )
                            else:
                                message += "  %d files were removed from the repository root.  " % len( files_to_remove )
                        kwd[ 'message' ] = message
                        suc.set_repository_metadata_due_to_new_tip( trans, repository, content_alert_str=content_alert_str, **kwd )
                    # Provide a warning message if a tool_dependencies.xml file is provided, but tool dependencies weren't loaded due to a requirement tag mismatch
                    # or some other problem.
                    if suc.get_config_from_disk( 'tool_dependencies.xml', repo_dir ):
                        if repository.metadata_revisions:
                            # A repository's metadata revisions are order descending by update_time, so the zeroth revision will be the tip just after an upload.
                            metadata_dict = repository.metadata_revisions[0].metadata
                        else:
                            metadata_dict = {}
                        if suc.has_orphan_tool_dependencies_in_tool_shed( metadata_dict ):
                            message += 'Name, version and type from a tool requirement tag does not match the information in the "tool_dependencies.xml file", '
                            message += 'so one or more of the defined tool dependencies are considered orphans within this repository.'
                            status = 'warning'
                    # Reset the tool_data_tables by loading the empty tool_data_table_conf.xml file.
                    suc.reset_tool_data_tables( trans.app )
                    trans.response.send_redirect( web.url_for( controller='repository',
                                                               action='browse_repository',
                                                               id=repository_id,
                                                               commit_message='Deleted selected files',
                                                               message=message,
                                                               status=status ) )
                else:
                    status = 'error'
                # Reset the tool_data_tables by loading the empty tool_data_table_conf.xml file.
                suc.reset_tool_data_tables( trans.app )
        selected_categories = [ trans.security.decode_id( id ) for id in category_ids ]
        return trans.fill_template( '/webapps/community/repository/upload.mako',
                                    repository=repository,
                                    url=url,
                                    commit_message=commit_message,
                                    uncompress_file=uncompress_file,
                                    remove_repo_files_not_in_tar=remove_repo_files_not_in_tar,
                                    message=message,
                                    status=status )
    def upload_directory( self, trans, repository, uploaded_directory, upload_point, remove_repo_files_not_in_tar, commit_message, new_repo_alert ):
        repo_dir = repository.repo_path( trans.app )
        repo = hg.repository( suc.get_configured_ui(), repo_dir )
        undesirable_dirs_removed = 0
        undesirable_files_removed = 0
        if upload_point is not None:
            full_path = os.path.abspath( os.path.join( repo_dir, upload_point ) )
        else:
            full_path = os.path.abspath( repo_dir )
        filenames_in_archive = []
        for root, dirs, files in os.walk( uploaded_directory ):
            for uploaded_file in files:
                relative_path = os.path.normpath(os.path.join(os.path.relpath(root, uploaded_directory), uploaded_file))
                ok = os.path.basename( uploaded_file ) not in undesirable_files
                if ok:
                    for file_path_item in relative_path.split( '/' ):
                        if file_path_item in undesirable_dirs:
                            undesirable_dirs_removed += 1
                            ok = False
                            break
                else:
                    undesirable_files_removed += 1
                if ok:
                    repo_path = os.path.join(full_path, relative_path)
                    repo_basedir = os.path.normpath(os.path.join(repo_path, os.path.pardir))
                    if not os.path.exists(repo_basedir):
                        os.makedirs(repo_basedir)
                    if os.path.exists(repo_path):
                        if os.path.isdir(repo_path):
                            shutil.rmtree(repo_path)
                        else:
                            os.remove(repo_path)
                    shutil.move(os.path.join(uploaded_directory, relative_path), repo_path)
                    filenames_in_archive.append( relative_path )
        return self.__handle_directory_changes(trans, repository, full_path, filenames_in_archive, remove_repo_files_not_in_tar, new_repo_alert, commit_message, undesirable_dirs_removed, undesirable_files_removed)
    def upload_tar( self, trans, repository, tar, uploaded_file, upload_point, remove_repo_files_not_in_tar, commit_message, new_repo_alert ):
        # Upload a tar archive of files.
        repo_dir = repository.repo_path( trans.app )
        repo = hg.repository( suc.get_configured_ui(), repo_dir )
        undesirable_dirs_removed = 0
        undesirable_files_removed = 0
        ok, message = self.__check_archive( tar )
        if not ok:
            tar.close()
            uploaded_file.close()
            return ok, message, [], '', undesirable_dirs_removed, undesirable_files_removed
        else:
            if upload_point is not None:
                full_path = os.path.abspath( os.path.join( repo_dir, upload_point ) )
            else:
                full_path = os.path.abspath( repo_dir )
            filenames_in_archive = []
            for tarinfo_obj in tar.getmembers():
                ok = os.path.basename( tarinfo_obj.name ) not in undesirable_files
                if ok:
                    for file_path_item in tarinfo_obj.name.split( '/' ):
                        if file_path_item in undesirable_dirs:
                            undesirable_dirs_removed += 1
                            ok = False
                            break
                else:
                    undesirable_files_removed += 1
                if ok:
                    filenames_in_archive.append( tarinfo_obj.name )
            # Extract the uploaded tar to the load_point within the repository hierarchy.
            tar.extractall( path=full_path )
            tar.close()
            uploaded_file.close()
            return self.__handle_directory_changes(trans, repository, full_path, filenames_in_archive, remove_repo_files_not_in_tar, new_repo_alert, commit_message, undesirable_dirs_removed, undesirable_files_removed)
    def __handle_directory_changes( self, trans, repository, full_path, filenames_in_archive, remove_repo_files_not_in_tar, new_repo_alert, commit_message, undesirable_dirs_removed, undesirable_files_removed ):    
        repo_dir = repository.repo_path( trans.app )
        repo = hg.repository( suc.get_configured_ui(), repo_dir )
        content_alert_str = ''
        files_to_remove = []
        filenames_in_archive = [ os.path.join( full_path, name ) for name in filenames_in_archive ]
        if remove_repo_files_not_in_tar and not repository.is_new( trans.app ):
            # We have a repository that is not new (it contains files), so discover
            # those files that are in the repository, but not in the uploaded archive.
            for root, dirs, files in os.walk( full_path ):
                if root.find( '.hg' ) < 0 and root.find( 'hgrc' ) < 0:
                    for undesirable_dir in undesirable_dirs:
                        if undesirable_dir in dirs:
                            dirs.remove( undesirable_dir )
                            undesirable_dirs_removed += 1
                    for undesirable_file in undesirable_files:
                        if undesirable_file in files:
                            files.remove( undesirable_file )
                            undesirable_files_removed += 1
                    for name in files:
                        full_name = os.path.join( root, name )
                        if full_name not in filenames_in_archive:
                            files_to_remove.append( full_name )
            for repo_file in files_to_remove:
                # Remove files in the repository (relative to the upload point) that are not in the uploaded archive.
                try:
                    commands.remove( repo.ui, repo, repo_file, force=True )
                except Exception, e:
                    log.debug( "Error removing files using the mercurial API, so trying a different approach, the error was: %s" % str( e ))
                    relative_selected_file = selected_file.split( 'repo_%d' % repository.id )[1].lstrip( '/' )
                    repo.dirstate.remove( relative_selected_file )
                    repo.dirstate.write()
                    absolute_selected_file = os.path.abspath( selected_file )
                    if os.path.isdir( absolute_selected_file ):
                        try:
                            os.rmdir( absolute_selected_file )
                        except OSError, e:
                            # The directory is not empty
                            pass
                    elif os.path.isfile( absolute_selected_file ):
                        os.remove( absolute_selected_file )
                        dir = os.path.split( absolute_selected_file )[0]
                        try:
                            os.rmdir( dir )
                        except OSError, e:
                            # The directory is not empty
                            pass
        # See if any admin users have chosen to receive email alerts when a repository is
        # updated.  If so, check every uploaded file to ensure content is appropriate.
        check_contents = suc.check_file_contents( trans )
        for filename_in_archive in filenames_in_archive:
            # Check file content to ensure it is appropriate.
            if check_contents and os.path.isfile( filename_in_archive ):
                content_alert_str += self.__check_file_content( filename_in_archive )
            commands.add( repo.ui, repo, filename_in_archive )
            if filename_in_archive.endswith( 'tool_data_table_conf.xml.sample' ):
                # Handle the special case where a tool_data_table_conf.xml.sample file is being uploaded by parsing the file and adding new entries
                # to the in-memory trans.app.tool_data_tables dictionary.
                error, message = suc.handle_sample_tool_data_table_conf_file( trans.app, filename_in_archive )
                if error:
                    return False, message, files_to_remove, content_alert_str, undesirable_dirs_removed, undesirable_files_removed
        commands.commit( repo.ui, repo, full_path, user=trans.user.username, message=commit_message )
        admin_only = len( repository.downloadable_revisions ) != 1
        suc.handle_email_alerts( trans, repository, content_alert_str=content_alert_str, new_repo_alert=new_repo_alert, admin_only=admin_only )
        return True, '', files_to_remove, content_alert_str, undesirable_dirs_removed, undesirable_files_removed
    def uncompress( self, repository, uploaded_file_name, uploaded_file_filename, isgzip, isbz2 ):
        if isgzip:
            self.__handle_gzip( repository, uploaded_file_name )
            return uploaded_file_filename.rstrip( '.gz' )
        if isbz2:
            self.__handle_bz2( repository, uploaded_file_name )
            return uploaded_file_filename.rstrip( '.bz2' )
    def __handle_gzip( self, repository, uploaded_file_name ):
        fd, uncompressed = tempfile.mkstemp( prefix='repo_%d_upload_gunzip_' % repository.id, dir=os.path.dirname( uploaded_file_name ), text=False )
        gzipped_file = gzip.GzipFile( uploaded_file_name, 'rb' )
        while 1:
            try:
                chunk = gzipped_file.read( CHUNK_SIZE )
            except IOError, e:
                os.close( fd )
                os.remove( uncompressed )
                log.exception( 'Problem uncompressing gz data "%s": %s' % ( uploaded_file_name, str( e ) ) )
                return
            if not chunk:
                break
            os.write( fd, chunk )
        os.close( fd )
        gzipped_file.close()
        shutil.move( uncompressed, uploaded_file_name )
    def __handle_bz2( self, repository, uploaded_file_name ):
        fd, uncompressed = tempfile.mkstemp( prefix='repo_%d_upload_bunzip2_' % repository.id, dir=os.path.dirname( uploaded_file_name ), text=False )
        bzipped_file = bz2.BZ2File( uploaded_file_name, 'rb' )
        while 1:
            try:
                chunk = bzipped_file.read( CHUNK_SIZE )
            except IOError:
                os.close( fd )
                os.remove( uncompressed )
                log.exception( 'Problem uncompressing bz2 data "%s": %s' % ( uploaded_file_name, str( e ) ) )
                return
            if not chunk:
                break
            os.write( fd, chunk )
        os.close( fd )
        bzipped_file.close()
        shutil.move( uncompressed, uploaded_file_name )
    def __get_upload_point( self, repository, **kwd ):
        upload_point = kwd.get( 'upload_point', None )
        if upload_point is not None:
            # The value of upload_point will be something like: database/community_files/000/repo_12/1.bed
            if os.path.exists( upload_point ):
                if os.path.isfile( upload_point ):
                    # Get the parent directory
                    upload_point, not_needed = os.path.split( upload_point )
                    # Now the value of uplaod_point will be something like: database/community_files/000/repo_12/
                upload_point = upload_point.split( 'repo_%d' % repository.id )[ 1 ]
                if upload_point:
                    upload_point = upload_point.lstrip( '/' )
                    upload_point = upload_point.rstrip( '/' )
                # Now the value of uplaod_point will be something like: /
                if upload_point == '/':
                    upload_point = None
            else:
                # Must have been an error selecting something that didn't exist, so default to repository root
                upload_point = None
        return upload_point
    def __check_archive( self, archive ):
        for member in archive.getmembers():
            # Allow regular files and directories only
            if not ( member.isdir() or member.isfile() or member.islnk() ):
                message = "Uploaded archives can only include regular directories and files (no symbolic links, devices, etc). Offender: %s" % str( member )
                return False, message
            for item in [ '.hg', '..', '/' ]:
                if member.name.startswith( item ):
                    message = "Uploaded archives cannot contain .hg directories, absolute filenames starting with '/', or filenames with two dots '..'."
                    return False, message
            if member.name in [ 'hgrc' ]:
                message = "Uploaded archives cannot contain hgrc files."
                return False, message
        return True, ''
    def __check_file_content( self, file_path ):
        message = ''
        if checkers.check_html( file_path ):
            message = 'The file "%s" contains HTML content.\n' % str( file_path )
        elif checkers.check_image( file_path ):
            message = 'The file "%s" contains image content.\n' % str( file_path )
        return message
